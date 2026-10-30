// server/auth.js
// Handles admin authentication: login, logout, session checks.
// Passwords are bcrypt-hashed. We support two admin sources:
//   1) A single "root" admin defined via ADMIN_USERNAME / ADMIN_PASSWORD_HASH env vars.
//   2) Additional admins stored in the Supabase "users" table (optional, for future expansion).

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
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

// --- Roles ---
// admin  — everything, including administrator accounts and security logs
// editor — website content only (projects, services, blog, reviews, messages, media)
const ROLES = ['admin', 'editor'];

// --- CSRF protection ---
// The session cookie is SameSite=Lax, and every state-changing admin request
// must also echo a per-session token in the X-CSRF-Token header (synchronizer
// token pattern). A cross-site form or fetch cannot read the token, so it
// cannot forge admin writes.
function ensureCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  return req.session.csrfToken;
}

function csrfValid(req) {
  const expected = req.session?.csrfToken;
  const given = req.get('x-csrf-token');
  if (!expected || !given || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// --- Express middleware: require an authenticated admin session ---
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!SAFE_METHODS.has(req.method) && !csrfValid(req)) {
    return res.status(403).json({ error: 'Your session token has expired. Please refresh the page and try again.', code: 'CSRF' });
  }
  return next();
}

// --- Express middleware: require one of the given roles (use after requireAuth) ---
function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.session?.user?.role || 'admin';
    if (!roles.includes(role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
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
    const ipHash = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 10);
    logActivity(null, 'login_failed', `Failed sign-in for "${username.trim().slice(0, 60)}" (client ${ipHash})`);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  clearAttempts(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Login failed. Please try again.' });
    const role = ROLES.includes(user.role) ? user.role : 'admin';
    req.session.user = { id: user.id, username: user.username, role };
    const csrfToken = ensureCsrfToken(req);
    logActivity(req.session.user, 'login', 'Signed in');
    res.json({ success: true, user: { username: user.username, role }, csrfToken });
  });
}

function logout(req, res) {
  const user = req.session?.user;
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    if (user) logActivity(user, 'logout', 'Signed out');
    res.json({ success: true });
  });
}

function checkSession(req, res) {
  res.set('Cache-Control', 'no-store');
  if (req.session && req.session.user) {
    const { username, role } = req.session.user;
    return res.json({ authenticated: true, user: { username, role: role || 'admin' }, csrfToken: ensureCsrfToken(req) });
  }
  res.json({ authenticated: false });
}

module.exports = { requireAuth, requireRole, ROLES, login, logout, checkSession };