const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const queryRoutes = require('./routes/query');
const ingestionRoutes = require('./routes/ingestion');
const auditRoutes = require('./routes/audit');
const healthRoutes = require('./routes/health');

const app = express();

// ---------------------
// Global Middleware
// ---------------------
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// ---------------------
// Routes
// ---------------------
app.use('/api/health', healthRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/ingest', ingestionRoutes);
app.use('/api/audit', auditRoutes);

// ---------------------
// Error Handler
// ---------------------
app.use((err, req, res, _next) => {
  console.error('[GlobalError]', err.stack);

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.' });
  }

  if (err.message?.includes('Only PDF')) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({
    error: 'Internal server error.',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

module.exports = app;
