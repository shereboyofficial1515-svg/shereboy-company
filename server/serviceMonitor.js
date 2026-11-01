// server/serviceMonitor.js
// Coordinates wake-up of SHEREBOY BLOG and SHEREBOY AFFILIATE CONCEPT.
//
// Free Render services sleep when idle and can take a minute or more to start.
// A visitor's page must never wait for that, so page requests only *trigger*
// this module and return immediately. Each service is tracked on its own:
//
//   unknown → waking → ready      the app answered and confirmed its database works
//                    → degraded   the app answered but reported it is not ready
//                    → down       the wake-up window ended without a ready answer
//
// Rules: checks run concurrently and independently; each attempt has a timeout;
// retries use exponential backoff with jitter inside a fixed window (never an
// endless loop); one wake-up per service runs at a time; results are cached so
// busy pages do not multiply outbound requests; after a failed window there is a
// cool-down. Logs carry the service name and outcome only, never credentials.
const errorLog = require('./errorLog');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const strip = (u) => String(u || '').trim().replace(/\/+$/, '');

function settings() {
  return {
    attemptTimeoutMs: num(process.env.SERVICE_ATTEMPT_TIMEOUT_SECONDS, 20) * 1000,
    windowMs: num(process.env.SERVICE_WAKE_WINDOW_SECONDS, 120) * 1000,
    backoffBaseMs: num(process.env.SERVICE_BACKOFF_BASE_MS, 2000),
    backoffMaxMs: num(process.env.SERVICE_BACKOFF_MAX_MS, 30000),
    healthyCacheMs: num(process.env.SERVICE_HEALTH_CACHE_SECONDS, 60) * 1000,
    downCooldownMs: num(process.env.SERVICE_DOWN_COOLDOWN_SECONDS, 120) * 1000,
    activeVisitorMs: num(process.env.SERVICE_ACTIVE_VISITOR_MINUTES, 20) * 60 * 1000
  };
}

const services = {
  blog: {
    name: 'SHEREBOY BLOG',
    base: () => strip(process.env.BLOG_API_BASE_URL) || 'https://shereblog-news.onrender.com'
  },
  affiliate: {
    name: 'SHEREBOY AFFILIATE CONCEPT',
    base: () => strip(process.env.AFFILIATE_API_BASE_URL) || 'https://shereboyaffiliateconcept.shop'
  }
};

const state = {};
Object.keys(services).forEach((key) => {
  state[key] = {
    status: 'unknown', lastCheckedAt: 0, lastReadyAt: 0, lastError: null, lastDurationMs: null,
    wakeStartedAt: 0, lastWakeMs: null, attempts: 0, inFlight: null, onReady: null
  };
});

let lastVisitorAt = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Exponential backoff with equal jitter, capped. */
function backoffDelay(attempt, base, max) {
  const ceiling = Math.min(max, base * (2 ** attempt));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/**
 * One readiness check. A 200 alone is not enough: Render's own proxy and a
 * half-started process can both answer, so the body must be the app's JSON
 * confirming readiness. `/api/health` is preferred; `/api/public/status` (which
 * queries the database) is the fallback for a version without the health route.
 */
async function checkOnce(base, timeoutMs, path = '/api/health') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'SHEREBOY-TECH-Service-Monitor/1.0' }
    });
    const durationMs = Date.now() - started;
    if (res.status === 404 && path === '/api/health') {
      clearTimeout(timer);
      return checkOnce(base, timeoutMs, '/api/public/status');
    }
    const type = res.headers.get('content-type') || '';
    let body = null;
    if (type.includes('application/json')) { try { body = await res.json(); } catch { body = null; } }
    if (res.ok && body && body.success === true && body.ready !== false) return { outcome: 'ready', durationMs };
    if (body && body.ready === false) return { outcome: 'degraded', durationMs, error: 'The service is running but reported that it is not ready' };
    if (res.status === 429 || res.status >= 500) return { outcome: 'retry', durationMs, error: `HTTP ${res.status}` };
    if (res.ok) return { outcome: 'retry', durationMs, error: 'The response did not confirm readiness' };
    return { outcome: 'failed', durationMs, error: `HTTP ${res.status}` };
  } catch (err) {
    return { outcome: 'retry', durationMs: Date.now() - started, error: err.name === 'AbortError' ? 'Timed out waiting for a response' : 'Could not connect' };
  } finally {
    clearTimeout(timer);
  }
}

async function runWake(key) {
  const c = settings();
  const s = state[key];
  const base = services[key].base();
  const started = Date.now();
  s.wakeStartedAt = started;
  s.attempts = 0;
  if (s.status !== 'ready') s.status = 'waking';

  while (Date.now() - started < c.windowMs) {
    s.attempts += 1;
    const r = await checkOnce(base, c.attemptTimeoutMs);
    s.lastCheckedAt = Date.now();
    s.lastDurationMs = r.durationMs;

    if (r.outcome === 'ready') {
      const wasReady = s.status === 'ready';
      s.status = 'ready';
      s.lastReadyAt = Date.now();
      s.lastError = null;
      s.lastWakeMs = Date.now() - started;
      if (!wasReady) console.log(`[services] ${services[key].name} ready after ${s.lastWakeMs} ms (${s.attempts} attempt${s.attempts === 1 ? '' : 's'})`);
      if (s.onReady) { try { s.onReady(); } catch { /* a feed refresh records its own errors */ } }
      return s.status;
    }
    s.lastError = r.error || 'Not ready';
    if (r.outcome === 'failed') break;
    if (r.outcome === 'degraded') s.status = 'degraded';
    else if (s.status === 'ready') s.status = 'waking';

    const delay = backoffDelay(s.attempts - 1, c.backoffBaseMs, c.backoffMaxMs);
    if (Date.now() - started + delay >= c.windowMs) break;
    await sleep(delay);
  }

  s.status = s.status === 'degraded' ? 'degraded' : 'down';
  s.lastCheckedAt = Date.now();
  console.warn(`[services] ${services[key].name} not ready after ${s.attempts} attempt(s): ${s.lastError}`);
  errorLog.record('services', `${services[key].name} not ready after ${s.attempts} attempt(s): ${s.lastError}`);
  return s.status;
}

/** Starts (or joins) one service's wake-up, unless a recent result is still valid. Never rejects. */
function wake(key, { force = false } = {}) {
  const c = settings();
  const s = state[key];
  if (s.inFlight) return s.inFlight;
  const age = Date.now() - s.lastCheckedAt;
  if (!force && s.lastCheckedAt) {
    if (s.status === 'ready' && age < c.healthyCacheMs) return Promise.resolve(s.status);
    if (s.status !== 'ready' && age < c.downCooldownMs) return Promise.resolve(s.status);
  }
  s.inFlight = runWake(key)
    .catch((err) => { s.status = 'down'; s.lastError = 'Check failed'; errorLog.record('services', err.message); return s.status; })
    .finally(() => { s.inFlight = null; });
  return s.inFlight;
}

const wakeAll = (opts) => Promise.allSettled(Object.keys(services).map(key => wake(key, opts)));

/** Called on page and feed requests. Returns at once; the work runs in the background. */
function touch() {
  lastVisitorAt = Date.now();
  wakeAll();
}

/** Express middleware for real page views: triggers wake-up without delaying the response. */
function onPageView(req, res, next) {
  if (req.method === 'GET') touch();
  next();
}

/** Periodic feed refreshes run only with recent visitors, so idle free services are allowed to sleep. */
const hasRecentVisitors = () => Date.now() - lastVisitorAt < settings().activeVisitorMs;

function onReady(key, fn) { state[key].onReady = fn; }

/** What a feed should tell the browser while it has nothing to show yet. */
function feedHint(key) {
  const s = state[key];
  if (s.inFlight || s.status === 'unknown' || s.status === 'waking') return 'waking';
  return 'unavailable';
}

function snapshot() {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return Object.fromEntries(Object.entries(state).map(([key, s]) => [key, {
    name: services[key].name,
    baseUrl: services[key].base(),
    status: s.inFlight && s.status !== 'ready' ? 'waking' : s.status,
    checking: !!s.inFlight,
    lastCheckedAt: iso(s.lastCheckedAt),
    lastReadyAt: iso(s.lastReadyAt),
    lastError: s.lastError,
    lastDurationMs: s.lastDurationMs,
    lastWakeMs: s.lastWakeMs,
    attempts: s.attempts
  }]));
}

module.exports = { wake, wakeAll, touch, onPageView, hasRecentVisitors, onReady, feedHint, snapshot, backoffDelay, checkOnce, _state: state };
