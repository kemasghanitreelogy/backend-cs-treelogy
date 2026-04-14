const dotenv = require('dotenv');
const path = require('path');

// Load .env for local development; on Vercel, env vars are injected directly
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const required = [
  'HF_API_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'TAVILY_API_KEY',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0 && process.env.NODE_ENV === 'production') {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  hf: {
    apiToken: process.env.HF_API_TOKEN,
    modelId: process.env.HF_MODEL_ID || 'mistralai/Mistral-Large-Instruct-2407',
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  tavily: {
    apiKey: process.env.TAVILY_API_KEY,
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 20,
  },
};
