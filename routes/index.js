const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

// MySQL Database Connection Pool
const dbPool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

/* GET home page. */
router.get('/', function(req, res, next) {
  res.json({ title: 'Express' });
});


// --- API ENDPOINTS ---

/**
 * GET /api/sync-status
 * Returns the timestamp of the last successful data sync.
 */
router.get('/api/sync-status', async (req, res) => {
  try {
    const [rows] = await dbPool.query('SELECT last_sync_timestamp FROM sync_log ORDER BY id DESC LIMIT 1');
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No sync has been performed yet.' });
    }
    res.json({ lastSync: new Date(rows[0].last_sync_timestamp).toLocaleDateString('en-US', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).replace(',', ' of') });
  } catch (error) {
    console.error('Error fetching sync status:', error);
    res.status(500).json({ error: 'Failed to retrieve sync status.' });
  }
});

/**
 * POST /api/sync
 * Fetches new receipts AND customers from Loyverse, stores them in MySQL, and sends data to Python service for vectorization.
 * In a real-world scenario, this endpoint should be protected (e.g., require a secret API key).
 */
router.post('/api/sync', async (req, res) => {
  let connection;
  try {
    connection = await dbPool.getConnection();
    await connection.beginTransaction();

    // 1. Get the last sync timestamp from our database
    const [rows] = await connection.query('SELECT last_sync_timestamp FROM sync_log ORDER BY id DESC LIMIT 1');
    const lastSync = new Date(rows[0].last_sync_timestamp);
    const now = new Date();

    const syncParams = {
      created_at_min: lastSync.toISOString(),
      created_at_max: now.toISOString(),
      limit: 250 // Max limit per call
    };
    const apiHeaders = { 'Authorization': `Bearer ${process.env.LOYVERSE_TOKEN}` };

    // 2. Fetch and process customer data
    console.log(`Syncing customers from ${syncParams.created_at_min} to ${syncParams.created_at_max}`);
    const loyverseCustomersResponse = await axios.get('https://api.loyverse.com/v1.0/customers', {
      headers: apiHeaders,
      params: syncParams
    });
    const customers = loyverseCustomersResponse.data.customers || [];
    for (const customer of customers) {
      await connection.query(
          `INSERT INTO customers (id, name, email, phone_number, total_visits, total_spent, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                                name = VALUES(name),
                                email = VALUES(email),
                                phone_number = VALUES(phone_number),
                                total_visits = VALUES(total_visits),
                                total_spent = VALUES(total_spent),
                                updated_at = VALUES(updated_at)`,
          [customer.id, customer.name, customer.email, customer.phone_number, customer.total_visits, customer.total_spent, new Date(customer.updated_at)]
      );
    }
    console.log(`Synced ${customers.length} customers.`);

    // 3. Fetch receipt data from Loyverse API
    console.log(`Syncing receipts from ${syncParams.created_at_min} to ${syncParams.created_at_max}`);
    const loyverseReceiptsResponse = await axios.get('https://api.loyverse.com/v1.0/receipts', {
      headers: apiHeaders,
      params: syncParams
    });

    const receipts = loyverseReceiptsResponse.data.receipts;
    if (receipts.length === 0 && customers.length === 0) {
      await connection.commit();
      return res.json({ message: 'No new data to sync.' });
    }

    const documentsForVectorization = [];

    // 4. Process and save each receipt
    for (const receipt of receipts) {
      // -- Insert customer placeholder if not exists (as a fallback) --
      if (receipt.customer_id) {
        // Using INSERT IGNORE so we don't overwrite detailed data from the customer sync
        await connection.query(
            'INSERT IGNORE INTO customers (id, name, updated_at) VALUES (?, ?, ?)',
            [receipt.customer_id, 'Unknown Customer', receipt.created_at]
        );
      }

      // -- Save Receipt --
      await connection.query(
          'INSERT INTO receipts (receipt_number, created_at, total_money, total_tax, source, customer_id) VALUES (?, ?, ?, ?, ?, ?)',
          [receipt.receipt_number, receipt.created_at, receipt.total_money, receipt.total_tax, receipt.source, receipt.customer_id]
      );

      // -- Save Line Items and build text for AI --
      let receiptDescription = `On ${new Date(receipt.created_at).toLocaleString()}, receipt ${receipt.receipt_number} was created totaling ${receipt.total_money}. Items sold: `;
      const itemSummaries = [];

      for (const item of receipt.line_items) {
        await connection.query(
            'INSERT INTO line_items (receipt_number, item_name, quantity, price) VALUES (?, ?, ?, ?)',
            [receipt.receipt_number, item.item_name, item.quantity, item.price]
        );
        itemSummaries.push(`${item.quantity} of ${item.item_name}`);
      }
      receiptDescription += itemSummaries.join(', ') + '.';
      documentsForVectorization.push(receiptDescription);
    }

    // 5. Send processed data to Python microservice for embedding (if there are new receipts)
    if (documentsForVectorization.length > 0) {
      console.log(`Sending ${documentsForVectorization.length} documents to AI service...`);
      await axios.post(`${process.env.PYTHON_SERVICE_URL}/embed-and-store`, {
        documents: documentsForVectorization
      });
    }

    // 6. Update the sync log with the current timestamp
    await connection.query('INSERT INTO sync_log (last_sync_timestamp) VALUES (?)', [now]);

    await connection.commit();
    res.json({ message: `Successfully synced ${receipts.length} receipts and ${customers.length} customers.` });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Sync failed:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'An error occurred during synchronization.' });
  } finally {
    if (connection) connection.release();
  }
});


/**
 * POST /api/chat
 * Forwards a business question to the Python AI service.
 */
router.post('/api/chat', async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Question is required.' });
  }
  try {
    const response = await axios.post(`${process.env.PYTHON_SERVICE_URL}/query/chat`, { question });
    res.json(response.data);
  } catch (error) {
    console.error('Error forwarding chat request:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to get a response from the AI service.' });
  }
});

/**
 * POST /api/analyze
 * Forwards an analytical question to the Python AI service.
 */
router.post('/api/analyze', async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Question is required.' });
  }
  try {
    const response = await axios.post(`${process.env.PYTHON_SERVICE_URL}/query/analyze`, { question });
    res.json(response.data);
  } catch (error) {
    console.error('Error forwarding analysis request:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to get a response from the AI service.' });
  }
});

module.exports = router;