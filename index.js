require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const memoryRoutes = require('./routes/memory');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

// Middleware
app.use(cors());
app.use(express.json());

// Health check + list of available endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'AI Memory Organizer API',
    database: mongoose.connection.name,
    endpoints: {
      createMemory: 'POST   /api/memories',
      listMemories: 'GET    /api/memories?userId=&status=&category=&minImportance=',
      getMemory: 'GET    /api/memories/:id',
      updateMemory: 'PUT    /api/memories/:id',
      deleteMemory: 'DELETE /api/memories/:id',
      countByCategory: 'GET    /api/memories/stats/by-category?userId=',
      activeVsArchived: 'GET    /api/memories/stats/status-ratio?userId=',
      textSearch: 'GET    /api/memories/search?q=',
    },
  });
});

app.use('/api/memories', memoryRoutes);

// Unknown routes
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
});

// Error handler (e.g. malformed JSON in the request body)
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log(`MongoDB connected -> ${MONGO_URI}`);
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
