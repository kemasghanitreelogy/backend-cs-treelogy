const { Router } = require('express');

const router = Router();

router.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Treelogy Wellness Truth Engine',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Temporary debug endpoint — remove after confirming env vars work
router.get('/debug-env', (req, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV || 'NOT SET',
    HF_API_TOKEN: process.env.HF_API_TOKEN ? 'SET' : 'MISSING',
    HF_MODEL_ID: process.env.HF_MODEL_ID ? 'SET' : 'MISSING',
    SUPABASE_URL: process.env.SUPABASE_URL ? 'SET' : 'MISSING',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'MISSING',
    TAVILY_API_KEY: process.env.TAVILY_API_KEY ? 'SET' : 'MISSING',
    cwd: process.cwd(),
  });
});

module.exports = router;
