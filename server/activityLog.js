// server/activityLog.js
// Lightweight helper to record admin activity in Supabase.
// Never log passwords, API keys, or any secret values here.

const supabase = require('./database');

// `actor` is either a session user object ({ id, username }) or a raw id/null.
async function logActivity(actor, action, details) {
  const userId = actor && typeof actor === 'object' ? actor.id : actor;
  const username = actor && typeof actor === 'object' ? actor.username : null;
  const text = [username ? `[${username}]` : null, details].filter(Boolean).join(' ');
  try {
    await supabase.from('activity_log').insert({
      user_id: !userId || userId === 'root-admin' ? null : userId,
      action,
      details: text ? String(text).slice(0, 500) : null
    });
  } catch (err) {
    // Never let logging failures break the main request
    console.error('[activityLog] failed to record activity:', err.message);
  }
}

module.exports = { logActivity };
