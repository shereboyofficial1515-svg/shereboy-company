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
const { clientIp } = require('./clientIp');

// --- Login attempt tracking (simple in-memory brute-force protection) ---
const loginAttempts = new Map(); // ip -> { count, firstAttempt, alerted }
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
// A second, higher limit per account stops an attacker who rotates addresses.
// It is deliberately above the per-address limit so that one person cannot
// lock an administrator out by mistyping, and it clears itself after the window.
const MAX_ACCOUNT_ATTEMPTS = 25;
const MAX_TRACKED = 5000;
const accountAttempts = new Map(); // lower-cased username -> { count, firstAttempt }

function accountLocked(username) {
  const entry = accountAttempts.get(username);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > WINDOW_MS) { accountAttempts.delete(username); return false; }
  return entry.count >= MAX_ACCOUNT_ATTEMPTS;
}

function recordAccountFailure(username) {
  if (accountAttempts.size >= MAX_TRACKED) accountAttempts.clear();
  const entry = accountAttempts.get(username);
  if (entry) entry.count += 1;
  else accountAttempts.set(username, { count: 1, firstAttempt: Date.now() });
}

// Compared when the username does not exist, so a wrong username takes as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

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
  if (loginAttempts.size >= MAX_TRACKED) loginAttempts.clear();
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

// A short fingerprint of the stored hash. Kept in the session so that resetting
// a password signs out that account's existing sessions.
const passwordFingerprint = (hash) => crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 16);

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

  if (error || !data) {
    await bcrypt.compare(password, DUMMY_HASH);
    return null;
  }

  const valid = await bcrypt.compare(password, data.password_hash);
  if (!valid) return null;

  return { id: data.id, username: data.username, role: data.role, pw: passwordFingerprint(data.password_hash) };
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

// --- Live account check ---
// A session must not outlive the account behind it: a deleted or demoted
// administrator loses access on their next request, not when their cookie expires.
// The lookup is cached briefly so that a busy admin page doesn't query per request.
const ACCOUNT_CACHE_MS = 15 * 1000;
const accountCache = new Map(); // id -> { at, account }

function forgetAccount(id) { accountCache.delete(id); }

async function currentAccount(sessionUser) {
  if (sessionUser.id === 'root-admin') {
    return sessionUser.username === process.env.ADMIN_USERNAME ? { role: 'admin', username: sessionUser.username } : null;
  }
  const cached = accountCache.get(sessionUser.id);
  if (cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) return cached.account;
  const { data, error } = await supabase.from('users').select('id, username, role, password_hash').eq('id', sessionUser.id).maybeSingle();
  // A temporary database problem is not proof that the account is gone
  if (error) return { role: sessionUser.role, username: sessionUser.username, pw: sessionUser.pw };
  const account = data ? { role: data.role, username: data.username, pw: passwordFingerprint(data.password_hash) } : null;
  if (accountCache.size >= MAX_TRACKED) accountCache.clear();
  accountCache.set(sessionUser.id, { at: Date.now(), account });
  return account;
}

// --- Express middleware: require an authenticated admin session ---
async function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  let account;
  try {
    account = await currentAccount(req.session.user);
  } catch {
    return res.status(503).json({ error: 'Could not confirm your account. Please try again.' });
  }
  if (!account || (req.session.user.pw && account.pw && account.pw !== req.session.user.pw)) {
    return req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    });
  }
  req.session.user.role = ROLES.includes(account.role) ? account.role : 'editor';
  if (!SAFE_METHODS.has(req.method) && !csrfValid(req)) {
    return res.status(403).json({ error: 'Your session token has expired. Please refresh the page and try again.', code: 'CSRF' });
  }
  return next();
}

// --- Express middleware: require one of the given roles (use after requireAuth) ---
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.session?.user?.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

// --- Login route handler ---
async function login(req, res) {
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (username.length > 100 || password.length > 200) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const accountKey = username.trim().toLowerCase();
  if (accountLocked(accountKey)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  const user = await verifyCredentials(username.trim(), password);
  if (!user) {
    recordFailedAttempt(ip);
    recordAccountFailure(accountKey);
    const ipHash = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 10);
    logActivity(null, 'login_failed', `Failed sign-in for "${username.trim().slice(0, 60)}" (client ${ipHash})`);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  clearAttempts(ip);
  accountAttempts.delete(accountKey);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Login failed. Please try again.' });
    const role = ROLES.includes(user.role) ? user.role : 'editor';
    req.session.user = { id: user.id, username: user.username, role, ...(user.pw ? { pw: user.pw } : {}) };
    const csrfToken = ensureCsrfToken(req);
    logActivity(req.session.user, 'login', 'Signed in');
    res.json({ success: true, user: { username: user.username, role }, csrfToken });
  });
}

function logout(req, res) {
  const user = req.session?.user;
  // Stops another site from signing an administrator out
  if (user && !csrfValid(req)) {
    return res.status(403).json({ error: 'Your session token has expired. Please refresh the page and try again.', code: 'CSRF' });
  }
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    if (user) logActivity(user, 'logout', 'Signed out');
    res.json({ success: true });
  });
}

async function checkSession(req, res) {
  res.set('Cache-Control', 'no-store');
  if (req.session && req.session.user) {
    let account = null;
    try { account = await currentAccount(req.session.user); } catch { account = { role: req.session.user.role, username: req.session.user.username }; }
    if (!account || (req.session.user.pw && account.pw && account.pw !== req.session.user.pw)) {
      return req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ authenticated: false }); });
    }
    req.session.user.role = ROLES.includes(account.role) ? account.role : 'editor';
    const { username, role } = req.session.user;
    return res.json({ authenticated: true, user: { username, role }, csrfToken: ensureCsrfToken(req) });
  }
  res.json({ authenticated: false });
}

module.exports = { requireAuth, requireRole, ROLES, login, logout, checkSession, forgetAccount, passwordFingerprint };