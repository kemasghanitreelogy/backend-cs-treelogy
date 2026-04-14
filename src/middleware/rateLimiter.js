const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const apiLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please try again later.',
    retryAfterMs: env.rateLimit.windowMs,
  },
  validate: { xForwardedForHeader: false },
});

// Stricter limit for the ingestion endpoint
const ingestionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Ingestion rate limit exceeded. Max 10 per hour.' },
});

module.exports = { apiLimiter, ingestionLimiter };
