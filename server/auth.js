// server/auth.js
// Handles admin authentication: login, logout, session checks.
// Passwords are bcrypt-hashed. We support two admin sources:
//   1) A single "root" admin defined via ADMIN_USERNAME / ADMIN_PASSWORD_HASH env vars.
//   2) Additional admins stored in the Supabase "users" table (optional, for future expansion).

const bcrypt = require('bcryptjs');
const supabase = require('./database');
const { logActivity } = require('./activityLog');
const { notifyFailedLoginAlert } = require('./email');

// --- Login attempt tracking (simple in-memory brute-force protection) ---
const loginAttempts = new Map(); // ip -> { count, firstAttempt, alerted }
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function isRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now(), alerted: false });
    return;
  }
  entry.count += 1;
  // Email once per window when the account is close to being locked out —
  // not on every single attempt, to avoid spamming the inbox.
  if (entry.count === MAX_ATTEMPTS - 2 && !entry.alerted) {
    entry.alerted = true;
    notifyFailedLoginAlert(ip, entry.count).catch(() => { });
  }
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// --- Core auth logic ---
async function verifyCredentials(username, password) {
  // 1) Check root admin from env vars
  const rootUsername = process.env.ADMIN_USERNAME;
  const rootHash = process.env.ADMIN_PASSWORD_HASH;

  if (rootUsername && rootHash && username === rootUsername) {
    const valid = await bcrypt.compare(password, rootHash);
    if (valid) return { id: 'root-admin', username: rootUsername, role: 'admin' };
    return null;
  }

  // 2) Check users table (for additional admins created later)
  const { data, error } = await supabase
    .from('users')
    .select('id, username, password_hash, role')
    .eq('username', username)
    .single();

  if (error || !data) return null;

  const valid = await bcrypt.compare(password, data.password_hash);
  if (!valid) return null;

  return { id: data.id, username: data.username, role: data.role };
}

// --- Express middleware: require an authenticated admin session ---
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: 'Authentication required.' });
}

// --- Login route handler ---
async function login(req, res) {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = await verifyCredentials(username.trim(), password);
  if (!user) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  clearAttempts(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Login failed. Please try again.' });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    logActivity(user.id, 'login', `Admin "${user.username}" logged in`);
    res.json({ success: true, user: { username: user.username } });
  });
}

function logout(req, res) {
  const username = req.session?.user?.username;
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    if (username) logActivity(null, 'logout', `Admin "${username}" logged out`);
    res.json({ success: true });
  });
}

function checkSession(req, res) {
  if (req.session && req.session.user) {
    return res.json({ authenticated: true, user: { username: req.session.user.username } });
  }
  res.json({ authenticated: false });
}

module.exports = { requireAuth, login, logout, checkSession };