Coffee Shop AI Sales Agent
This project provides a complete backend solution for analyzing sales data from a Loyverse POS system using a Gemini-powered AI agent. It consists of two main services: an Express.js API for data synchronization and client-facing endpoints, and a Python microservice for handling AI-powered analysis.

Architecture Overview
The system uses a sophisticated multi-agent architecture to provide accurate and insightful answers.

Express.js API (Primary Backend):

/sync: A secure endpoint that fetches new receipts and customer data from the Loyverse API. It saves this structured data into a MySQL database.

/sync-status: Returns the timestamp of the last successful data sync.

/chat & /analyze: Acts as a proxy, forwarding user questions to the correct agent in the Python microservice.

Python Microservice (AI & Data Engine):

The "Clerk" Agent (/chat): This agent is designed for fast, factual answers. It has a set of specific tools to query the MySQL database directly. When you ask a question like "When was my best day?", it uses the get_best_sales_day tool to get the answer instantly.

The "Strategist" Agent (/analyze): This is a more powerful agent for deep analysis. It doesn't use pre-defined tools. Instead, it understands your database schema and has one primary ability: to write and execute its own SQL queries. When you ask "What strategies can improve sales in the morning?", it will query sales data by hour, analyze the results, and form a strategic recommendation grounded in your entire dataset.

How to Set Up
Prerequisites
Node.js (v18+) and npm

Python (v3.9+) and pip

MySQL Server

A Loyverse API Access Token

A Google AI (Gemini) API Key

1. Database Setup
   Start your MySQL server.

Create a new database (e.g., coffee_shop_db).

Execute the schema.sql file provided to create the necessary tables.

2. Express.js API Setup
   cd express-api
   npm install
   cp .env.example .env # Fill out with your credentials
   npm start

3. Python Microservice Setup
   cd python-microservice
   python -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env # Fill out with your credentials
   uvicorn main:app --reload

API Endpoints
Express.js API (localhost:3000)
POST /api/sync
Manually triggers a data sync from Loyverse.

GET /api/sync-status
Checks the timestamp of the last successful synchronization.

POST /api/chat
Endpoint for the "Clerk" agent. Use it for specific, factual business questions.

Example Questions:

"Which is the last selling product?"

"When was the last visit of Andrea?"

"How much did I sell on 2025-08-01?"

"When was my best day?"

"Which is the most expensive item?"

"Who are our top 3 customers?"

Body: { "question": "Your business question here" }

POST /api/analyze
Endpoint for the "Strategist" agent. Use it for deeper analysis, forecasts, and strategy.

Example Questions:

"What are the sales projections for next month?"

"How would introducing a new matcha flavor perform, based on current tea sales?"

"What is the customer purchase frequency and how can we improve it?"

"Analyze our sales patterns during weekday mornings vs. weekend afternoons."

Body: { "question": "Your analytical question here" }