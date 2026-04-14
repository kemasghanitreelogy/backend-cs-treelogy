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

module.exports = router;
