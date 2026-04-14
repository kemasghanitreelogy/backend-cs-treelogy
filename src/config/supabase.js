const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

const supabase = createClient(env.supabase.url, env.supabase.serviceKey);

module.exports = supabase;
