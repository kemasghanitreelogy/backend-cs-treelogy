const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

if (!env.supabase.url || !env.supabase.serviceKey) {
  console.error('[Supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
}

const supabase = env.supabase.url && env.supabase.serviceKey
  ? createClient(env.supabase.url, env.supabase.serviceKey)
  : null;

module.exports = supabase;
