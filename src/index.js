const express = require('express');
const dotenv = require('dotenv');

// Load environment variables from .env if present
dotenv.config();

const { connectDB, seedDatabase } = require('./db');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON request body parsing
app.use(express.json());

// Mount the document store API
app.use('/api', routes);

// Root path details
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'Collaborative Document Store API',
    version: '1.0.0',
    endpoints: {
      create: 'POST /api/documents',
      retrieve: 'GET /api/documents/:slug',
      update: 'PUT /api/documents/:slug',
      delete: 'DELETE /api/documents/:slug',
      search: 'GET /api/search?q=query&tags=tag1,tag2',
      analyticsMostEdited: 'GET /api/analytics/most-edited',
      analyticsTagCooccurrence: 'GET /api/analytics/tag-cooccurrence'
    }
  });
});

// App health status
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

async function startServer() {
  try {
    // Connect to database
    await connectDB();

    // Perform database seeding on application startup
    await seedDatabase();

    app.listen(PORT, () => {
      console.log(`Collaborative Document Store API listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to bootstrap application:', error);
    process.exit(1);
  }
}

startServer();
