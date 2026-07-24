const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ffc3hwkm53tc4xgczvre.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZmYzNod2ttNTN0YzR4Z2N6dnJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjA0MTYyMDQsImV4cCI6MjAzNTk5MjIwNH0.4v_9829424_EXAMPLE_FALLBACK';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  logger.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not explicitly set in process.env, using default configured client.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

module.exports = supabase;
