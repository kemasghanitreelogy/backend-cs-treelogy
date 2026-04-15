// Dedicated Vercel Function for SSE streaming.
// Uses Web Streams API so Vercel streams bytes to the client without buffering.
// This bypasses Express to guarantee realtime `stage` events reach the frontend.

const { processQueryStream } = require('../../src/services/ragOrchestrator');

async function handler(req, res) {
  // CORS for SPA frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Parse body (Vercel may or may not pre-parse depending on runtime).
  let body = req.body;
  if (!body || typeof body === 'string') {
    body = await new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    }).catch(() => ({}));
  }

  const question = body?.question;
  if (!question) {
    res.status(400).json({ error: 'Missing question' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);

  // Prime the stream so any intermediary proxy releases headers immediately.
  res.write(`: connected\n\n`);

  // Heartbeat keeps the connection warm (and flushes any buffered bytes).
  const heartbeat = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { /* ignore */ }
  }, 5000);

  req.on('close', () => clearInterval(heartbeat));

  try {
    for await (const event of processQueryStream(question)) {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    }
  } catch (err) {
    console.error('[StreamFn] Error:', err);
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ error: 'Stream processing failed.' })}\n\n`);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

module.exports = handler;
module.exports.config = {
  runtime: 'nodejs',
  maxDuration: 300,
};
