const supabase = require('../config/supabase');
const crypto = require('crypto');

const TABLE_NAME = 'audit_logs';

/**
 * Log a question-answer interaction for compliance and improvement.
 */
async function logInteraction({
  question,
  answer,
  sourceType,
  confidence,
  verified,
  sources,
  userId,
  responseTimeMs,
}) {
  const entry = {
    id: crypto.randomUUID(),
    question,
    answer: typeof answer === 'string' ? answer.slice(0, 10000) : '',
    source_type: sourceType,
    confidence,
    verified,
    sources: JSON.stringify(sources || []),
    user_id: userId || 'anonymous',
    response_time_ms: responseTimeMs,
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from(TABLE_NAME).insert(entry);
  if (error) {
    console.error('[AuditLog] Failed to log interaction:', error.message);
  }

  return entry.id;
}

/**
 * Retrieve audit logs with optional filters.
 */
async function getAuditLogs({ sourceType, verified, limit = 50, offset = 0 } = {}) {
  let query = supabase
    .from(TABLE_NAME)
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (sourceType) query = query.eq('source_type', sourceType);
  if (verified !== undefined) query = query.eq('verified', verified);

  const { data, error } = await query;
  if (error) throw new Error(`Audit log query failed: ${error.message}`);
  return data;
}

module.exports = { logInteraction, getAuditLogs };
