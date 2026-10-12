const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// The Express app, separate from index.js (which connects to MongoDB and listens) so tests can import it
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

// Health check + list of available endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'AI Memory Organizer API',
    database: mongoose.connection.name,
    note: 'Everything except /api/auth/* needs "Authorization: Bearer <token>". List endpoints take ?limit= (max 100) and ?cursor=.',
    endpoints: {
      register: 'POST   /api/auth/register',
      login: 'POST   /api/auth/login',
      getAccount: 'GET    /api/users/me',
      updateAccount: 'PUT    /api/users/me',
      deleteAccount: 'DELETE /api/users/me',
      categories: 'GET    /api/categories | GET /api/categories/:id | POST, PUT, DELETE (admin only)',
      conversations: 'GET, POST /api/conversations | GET, PUT, DELETE /api/conversations/:id   (DELETE erases what was derived from it)',
      messages: 'GET, POST /api/conversations/:id/messages   (a user message queues an extraction job)',
      deleteMessage: 'DELETE /api/conversations/:id/messages/:messageId   (erases every memory derived only from it)',
      jobs: 'GET    /api/jobs?status= | GET /api/jobs/:id   (extraction jobs and their decisions)',
      createMemory: 'POST   /api/memories',
      listMemories: 'GET    /api/memories?status=&category=&minImportance=&asOf=&knownAt=&needsReview=',
      getMemory: 'GET    /api/memories/:id',
      memoryHistory: 'GET    /api/memories/:id/history',
      updateMemory: 'PUT    /api/memories/:id   (supersedes: creates a new version)',
      deleteMemory: 'DELETE /api/memories/:id   (retracts: the version is kept in the history)',
      auditLog: 'GET    /api/audit?memoryId=',
      countByCategory: 'GET    /api/memories/stats/by-category',
      activeVsArchived: 'GET    /api/memories/stats/status-ratio',
      textSearch: 'GET    /api/memories/search?q=',
      retrieve: 'GET    /api/memories/retrieve?q=&asOf=&k=   (hybrid: text + vector + recency + importance)',
      ask: 'POST   /api/ask   { question, asOf?, k? }   (answer with citations to the memories used)',
      consent: 'GET    /api/me/consent | PUT /api/me/consent/:category   { mode: store|ask|never, eraseExisting? }',
      suggestions: 'GET    /api/me/suggestions | POST /api/me/suggestions/:id/accept | DELETE /api/me/suggestions/:id',
      exportData: 'GET    /api/me/export?embeddings=   (everything stored about you, as JSON)',
      erasureCheck: 'GET    /api/me/erasure-check?text=   (proves nothing derived from erased data remains)',
    },
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/memories', require('./routes/memory'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/ask', require('./routes/ask'));
app.use('/api/me', require('./routes/me'));

// Unknown routes
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
});

// Error handler: maps known failures to 4xx, hides the details of unexpected ones
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = err.status;
  if (!status) {
    if (err.name === 'ValidationError' || err.name === 'CastError') status = 400;
    else if (err.type === 'entity.parse.failed') status = 400; // malformed JSON body
    else if (err.code === 11000) status = 409;
  }
  if (!status) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(status).json({ error: err.message });
});

module.exports = app;
