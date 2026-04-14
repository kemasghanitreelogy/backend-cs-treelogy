const Redis = require('ioredis');
const env = require('./env');

let redis = null;

function getRedis() {
  if (!redis) {
    redis = new Redis(env.redis.url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redis.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
  }
  return redis;
}

module.exports = { getRedis };
