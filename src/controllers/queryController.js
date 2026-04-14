const { processQuery, processQueryStream } = require('../services/ragOrchestrator');
const { getCachedAnswer, cacheAnswer, getPopularQuestions } = require('../services/cacheService');
const { logInteraction } = require('../services/auditLogger');

/**
 * POST /api/query
 * Standard JSON response for a wellness question.
 */
async function handleQuery(req, res) {
  const startTime = Date.now();
  const { question } = req.body;

  try {
    // Check cache first
    const cached = await getCachedAnswer(question);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const result = await processQuery(question);
    const responseTimeMs = Date.now() - startTime;

    // Cache the result
    await cacheAnswer(question, result);

    // Audit log (fire-and-forget)
    logInteraction({
      question,
      answer: result.answer,
      sourceType: result.sourceType,
      confidence: result.confidence,
      verified: result.verified,
      sources: result.sources,
      userId: req.headers['x-user-id'],
      responseTimeMs,
    }).catch((err) => console.error('[AuditLog] Error:', err.message));

    res.json({ ...result, cached: false, responseTimeMs });
  } catch (err) {
    console.error('[QueryController] Error:', err);
    res.status(500).json({
      error: 'An internal error occurred while processing your question.',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
}

/**
 * POST /api/query/stream
 * Server-Sent Events (SSE) streaming response.
 */
async function handleStreamQuery(req, res) {
  const { question } = req.body;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    const stream = processQueryStream(question);

    for await (const event of stream) {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    }
  } catch (err) {
    console.error('[StreamController] Error:', err);
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ error: 'Stream processing failed.' })}\n\n`);
  } finally {
    res.end();
  }
}

/**
 * GET /api/query/popular
 * Auto-generated FAQ from most frequently asked verified questions.
 */
async function handlePopularQuestions(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const data = await getPopularQuestions(limit);
    res.json({ questions: data, count: data.length });
  } catch (err) {
    console.error('[QueryController] Popular questions error:', err);
    res.status(500).json({ error: 'Failed to fetch popular questions.' });
  }
}

module.exports = { handleQuery, handleStreamQuery, handlePopularQuestions };
