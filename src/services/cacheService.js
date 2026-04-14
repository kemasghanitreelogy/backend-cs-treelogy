const { getRedis } = require('../config/redis');
const crypto = require('crypto');

const CACHE_TTL = 3600; // 1 hour in seconds
const CACHE_PREFIX = 'treelogy:answer:';

/**
 * Generate a deterministic cache key from a question.
 */
function getCacheKey(question) {
  const normalized = question.toLowerCase().trim().replace(/\s+/g, ' ');
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${CACHE_PREFIX}${hash}`;
}

/**
 * Retrieve a cached answer if available.
 */
async function getCachedAnswer(question) {
  try {
    const redis = getRedis();
    const key = getCacheKey(question);
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Redis unavailable — proceed without cache
  }
  return null;
}

/**
 * Cache an answer for a question.
 */
async function cacheAnswer(question, answer) {
  try {
    const redis = getRedis();
    const key = getCacheKey(question);
    await redis.setex(key, CACHE_TTL, JSON.stringify(answer));
  } catch {
    // Redis unavailable — skip caching silently
  }
}

/**
 * Invalidate cached answer for a question.
 */
async function invalidateCache(question) {
  try {
    const redis = getRedis();
    const key = getCacheKey(question);
    await redis.del(key);
  } catch {
    // Redis unavailable
  }
}

module.exports = { getCachedAnswer, cacheAnswer, invalidateCache };
