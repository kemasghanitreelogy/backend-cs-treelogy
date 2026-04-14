const { getRedis } = require('../config/redis');
const supabase = require('../config/supabase');
const crypto = require('crypto');

const CACHE_TTL = 3600; // 1 hour in seconds (Redis)
const CACHE_PREFIX = 'treelogy:answer:';

/**
 * Generate a deterministic hash from a question for cache lookup.
 */
function getQuestionHash(question) {
  const normalized = question.toLowerCase().trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function getRedisCacheKey(hash) {
  return `${CACHE_PREFIX}${hash.slice(0, 16)}`;
}

/**
 * Two-tier cache lookup: Redis (fast, ephemeral) → Supabase (persistent).
 */
async function getCachedAnswer(question) {
  const hash = getQuestionHash(question);

  // Tier 1: Redis
  try {
    const redis = getRedis();
    const key = getRedisCacheKey(hash);
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Redis unavailable
  }

  // Tier 2: Supabase persistent cache (also increments hit_count)
  try {
    const { data } = await supabase.rpc('cache_hit', { p_hash: hash });
    if (data) {
      // Backfill Redis for next hit
      try {
        const redis = getRedis();
        const key = getRedisCacheKey(hash);
        await redis.setex(key, CACHE_TTL, JSON.stringify({
          answer: data.answer,
          sources: data.sources,
          sourceType: data.source_type,
          confidence: data.confidence,
          verified: data.verified,
        }));
      } catch { /* Redis unavailable */ }

      return {
        answer: data.answer,
        sources: data.sources,
        sourceType: data.source_type,
        confidence: data.confidence,
        verified: data.verified,
      };
    }
  } catch {
    // Supabase cache unavailable
  }

  return null;
}

/**
 * Write answer to both Redis (ephemeral) and Supabase (persistent) caches.
 */
async function cacheAnswer(question, result) {
  const hash = getQuestionHash(question);

  // Redis
  try {
    const redis = getRedis();
    const key = getRedisCacheKey(hash);
    await redis.setex(key, CACHE_TTL, JSON.stringify(result));
  } catch {
    // Redis unavailable
  }

  // Supabase persistent cache (upsert: update if same hash exists)
  try {
    await supabase
      .from('ai_response_cache')
      .upsert({
        question_hash: hash,
        question,
        answer: result.answer,
        source_type: result.sourceType || 'none',
        confidence: result.confidence,
        verified: result.verified || false,
        sources: result.sources || [],
        disclaimer: result.disclaimer || null,
        hit_count: 1,
        last_hit_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
      }, { onConflict: 'question_hash' });
  } catch {
    // Supabase cache write failed — non-critical
  }
}

/**
 * Invalidate a cached answer from both tiers.
 */
async function invalidateCache(question) {
  const hash = getQuestionHash(question);

  try {
    const redis = getRedis();
    await redis.del(getRedisCacheKey(hash));
  } catch { /* Redis unavailable */ }

  try {
    await supabase
      .from('ai_response_cache')
      .delete()
      .eq('question_hash', hash);
  } catch { /* non-critical */ }
}

/**
 * Get popular cached questions for auto-FAQ generation.
 */
async function getPopularQuestions(limit = 20) {
  const { data, error } = await supabase
    .from('ai_popular_questions')
    .select('*')
    .limit(limit);

  if (error) throw new Error(`Popular questions query failed: ${error.message}`);
  return data;
}

module.exports = { getCachedAnswer, cacheAnswer, invalidateCache, getPopularQuestions };
