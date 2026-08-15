// server/database.js
// Central Supabase client. Uses the SERVICE ROLE key — this file must
// NEVER be imported by any code that ships to the browser.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    '[database.js] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
    'The app will start but any database call will fail until you set them in .env'
  );
}

const supabase = createClient(SUPABASE_URL || '', SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false }
});

module.exports = supabase;
