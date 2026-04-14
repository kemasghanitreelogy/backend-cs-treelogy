const { getAuditLogs } = require('../services/auditLogger');

/**
 * GET /api/audit
 * Retrieve audit logs with optional filters.
 */
async function handleGetAuditLogs(req, res) {
  try {
    const { sourceType, verified, limit, offset } = req.query;

    const logs = await getAuditLogs({
      sourceType,
      verified: verified !== undefined ? verified === 'true' : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });

    res.json({ count: logs.length, logs });
  } catch (err) {
    console.error('[AuditController] Error:', err);
    res.status(500).json({ error: 'Failed to retrieve audit logs.' });
  }
}

module.exports = { handleGetAuditLogs };
