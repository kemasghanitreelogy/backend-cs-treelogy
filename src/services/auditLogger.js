const supabase = require('../config/supabase');

/**
 * Log a question-answer interaction to ai_audit_logs for compliance.
 */
async function logInteraction({
  question,
  answer,
  sourceType,
  confidence,
  verified,
  sources,
  userId,
  sessionId,
  conversationId,
  responseTimeMs,
}) {
  const { error } = await supabase.from('ai_audit_logs').insert({
    question,
    answer_preview: typeof answer === 'string' ? answer.slice(0, 500) : '',
    source_type: sourceType || 'none',
    confidence,
    verified: verified || false,
    sources: sources || [],
    user_id: userId || null,
    session_id: sessionId || null,
    conversation_id: conversationId || null,
    response_time: responseTimeMs || null,
  });

  if (error) {
    console.error('[AuditLog] Failed to log interaction:', error.message);
  }
}

/**
 * Retrieve audit logs with optional filters.
 */
async function getAuditLogs({ sourceType, verified, flagged, limit = 50, offset = 0 } = {}) {
  let query = supabase
    .from('ai_audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (sourceType) query = query.eq('source_type', sourceType);
  if (verified !== undefined) query = query.eq('verified', verified);
  if (flagged !== undefined) query = query.eq('flagged', flagged);

  const { data, error } = await query;
  if (error) throw new Error(`Audit log query failed: ${error.message}`);
  return data;
}

/**
 * Flag an audit log entry for manual review.
 */
async function flagAuditEntry(id, reason) {
  const { error } = await supabase
    .from('ai_audit_logs')
    .update({ flagged: true, flag_reason: reason })
    .eq('id', id);

  if (error) throw new Error(`Flag audit entry failed: ${error.message}`);
}

module.exports = { logInteraction, getAuditLogs, flagAuditEntry };
