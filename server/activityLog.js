// server/activityLog.js
// Lightweight helper to record admin activity in Supabase.
// Never log passwords, API keys, or any secret values here.

const supabase = require('./database');

async function logActivity(userId, action, details) {
  try {
    await supabase.from('activity_log').insert({
      user_id: userId === 'root-admin' ? null : userId,
      action,
      details: details ? String(details).slice(0, 500) : null
    });
  } catch (err) {
    // Never let logging failures break the main request
    console.error('[activityLog] failed to record activity:', err.message);
  }
}

module.exports = { logActivity };
