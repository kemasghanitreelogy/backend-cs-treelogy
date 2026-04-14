const { Router } = require('express');
const { handleQuery, handleStreamQuery, handlePopularQuestions } = require('../controllers/queryController');
const { validateQuestion } = require('../middleware/validator');
const { sanitizerMiddleware } = require('../middleware/sanitizer');
const { apiLimiter } = require('../middleware/rateLimiter');

const router = Router();

// Standard JSON response
router.post('/', apiLimiter, sanitizerMiddleware, validateQuestion, handleQuery);

// SSE streaming response
router.post('/stream', apiLimiter, sanitizerMiddleware, validateQuestion, handleStreamQuery);

// Auto-generated popular questions (for FAQ page)
router.get('/popular', handlePopularQuestions);

module.exports = router;
