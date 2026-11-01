// server/routes/adminUsers.js
// Administrator accounts (the `users` table) and the security/activity log.
// Administrators only. The root account defined by ADMIN_USERNAME /
// ADMIN_PASSWORD_HASH lives in environment variables and is shown read-only.
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const supabase = require('../database');
const { requireAuth, requireRole, ROLES, forgetAccount, passwordFingerprint } = require('../auth');
const { logActivity } = require('../activityLog');

router.use(requireAuth, requireRole('admin'));

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,40}$/;

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password is too long.';
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

// GET /api/admin/users
router.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('id, username, role, created_at, updated_at').order('created_at');
  if (error) return res.status(500).json({ error: 'Failed to load administrator accounts.' });
  const accounts = (data || []).map(u => ({ ...u, source: 'database' }));
  if (process.env.ADMIN_USERNAME) {
    accounts.unshift({ id: 'root-admin', username: process.env.ADMIN_USERNAME, role: 'admin', source: 'environment' });
  }
  res.json({ users: accounts, currentUserId: req.session.user.id, roles: ROLES });
});

// POST /api/admin/users
router.post('/users', async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: 'Username must be 3–40 characters: letters, numbers, dot, dash or underscore.' });
  if (username === process.env.ADMIN_USERNAME) return res.status(400).json({ error: 'That username is already in use.' });
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  const safeRole = ROLES.includes(role) ? role : 'editor';

  const password_hash = await bcrypt.hash(password, 12);
  const { data, error } = await supabase.from('users').insert({ username, password_hash, role: safeRole }).select('id, username, role, created_at').single();
  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'That username is already in use.' });
    return res.status(500).json({ error: 'Failed to create the account.' });
  }
  logActivity(req.session.user, 'admin_created', `Created ${safeRole} account "${username}"`);
  res.status(201).json({ user: data });
});

// PUT /api/admin/users/:id — change role and/or reset password
router.put('/users/:id', async (req, res) => {
  if (req.params.id === 'root-admin') return res.status(400).json({ error: 'The main administrator account is managed through environment variables.' });
  const { role, password } = req.body || {};
  const payload = { updated_at: new Date().toISOString() };
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });
    if (req.params.id === req.session.user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own administrator role.' });
    payload.role = role;
  }
  if (password) {
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    payload.password_hash = await bcrypt.hash(password, 12);
  }
  const { data, error } = await supabase.from('users').update(payload).eq('id', req.params.id).select('id, username, role').single();
  if (error || !data) return res.status(404).json({ error: 'Account not found.' });
  forgetAccount(req.params.id);
  // Resetting your own password keeps this session; every other session for the account ends
  if (payload.password_hash && req.params.id === req.session.user.id) req.session.user.pw = passwordFingerprint(payload.password_hash);
  logActivity(req.session.user, 'admin_updated', `Updated account "${data.username}"${payload.role ? ` (role: ${payload.role})` : ''}${password ? ' — password reset' : ''}`);
  res.json({ user: data });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  if (req.params.id === 'root-admin') return res.status(400).json({ error: 'The main administrator account cannot be deleted here.' });
  if (req.params.id === req.session.user.id) return res.status(400).json({ error: 'You cannot delete the account you are signed in with.' });
  const { data } = await supabase.from('users').select('username').eq('id', req.params.id).single();
  if (!data) return res.status(404).json({ error: 'Account not found.' });
  const { error } = await supabase.from('users').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Failed to delete the account.' });
  forgetAccount(req.params.id);
  logActivity(req.session.user, 'admin_deleted', `Deleted account "${data.username}"`);
  res.json({ success: true });
});

// GET /api/admin/activity?page=&action=
router.get('/activity', async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  let query = supabase.from('activity_log').select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  if (req.query.filter === 'security') query = query.in('action', ['login', 'logout', 'login_failed', 'admin_created', 'admin_updated', 'admin_deleted']);
  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: 'Failed to load the activity log.' });
  res.json({ activity: data, total: count, page, limit });
});

module.exports = router;
