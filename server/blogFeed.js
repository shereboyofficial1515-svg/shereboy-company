// server/blogFeed.js
// Reads published articles from SHEREBOY BLOG (the single source of truth)
// through its read-only public API. Nothing is stored in this site's database —
// articles live only in a short-lived in-memory cache.
//
// Sync strategy:
//   * Serve from cache while fresh (BLOG_CACHE_TTL_SECONDS, default 5 min).
//   * When stale, serve the cached copy immediately and refresh in the background.
//   * The blog can push a signed webhook on publish/edit/unpublish/delete, which
//     triggers an immediate refresh (see routes/blogFeed.js).
//   * A low-frequency periodic refresh runs as a fallback.
//   * If the blog is unreachable, the last good copy is served for at most
//     BLOG_STALE_MAX_SECONDS (default 6 h) — after that the section shows an
//     error state rather than possibly outdated (unpublished/deleted) articles.

const DEFAULT_BLOG_URL = 'https://shereblog-news.onrender.com';

function cfg() {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const strip = (u) => String(u || '').trim().replace(/\/+$/, '');
  const apiBase = strip(process.env.BLOG_API_BASE_URL) || DEFAULT_BLOG_URL;
  return {
    apiBase,
    publicUrl: strip(process.env.BLOG_PUBLIC_URL) || apiBase,
    ttlMs: num(process.env.BLOG_CACHE_TTL_SECONDS, 300) * 1000,
    staleMaxMs: num(process.env.BLOG_STALE_MAX_SECONDS, 6 * 3600) * 1000,
    timeoutMs: num(process.env.BLOG_FETCH_TIMEOUT_MS, 10000),
    pageSize: Math.min(num(process.env.BLOG_FEED_SIZE, 7), 24),
    refreshIntervalMs: num(process.env.BLOG_REFRESH_INTERVAL_SECONDS, 900) * 1000
  };
}

const state = {
  articles: null,           // last good list (null = never fetched successfully)
  total: 0,
  fetchedAt: 0,             // ms timestamp of last successful fetch
  lastAttemptAt: 0,
  lastError: null,
  lastErrorAt: 0,
  lastDurationMs: null,
  inFlight: null
};

// ---------- Response validation (never trust remote JSON) ----------
const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sameOriginUrl(raw, base) {
  try {
    const u = new URL(raw);
    return u.origin === new URL(base).origin ? u.toString() : null;
  } catch { return null; }
}

function safeImageUrl(raw, publicUrl) {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return u.toString();
    // plain http is only acceptable from the blog itself in local development
    if (u.protocol === 'http:' && u.origin === new URL(publicUrl).origin) return u.toString();
  } catch { /* fall through */ }
  return null;
}

function normaliseArticle(a, c) {
  if (!a || typeof a !== 'object') return null;
  const slug = typeof a.slug === 'string' ? a.slug.trim() : '';
  const title = clip(a.title, 300);
  if (!SLUG_RE.test(slug) || !title || !isDate(a.publishedAt)) return null;
  // "Read More" must always open this exact article on SHEREBOY BLOG — never an arbitrary host
  const url = sameOriginUrl(a.url, c.publicUrl) || `${c.publicUrl}/article.html?slug=${encodeURIComponent(slug)}`;
  const imageUrl = a.image && safeImageUrl(a.image.url, c.publicUrl);
  return {
    slug,
    title,
    excerpt: clip(a.excerpt, 320),
    url,
    canonicalUrl: (typeof a.canonicalUrl === 'string' && /^https?:\/\//.test(a.canonicalUrl)) ? a.canonicalUrl : url,
    image: imageUrl ? { url: imageUrl, alt: clip(a.image.alt, 300) || title } : null,
    category: a.category && clip(a.category.name, 80) ? { name: clip(a.category.name, 80), slug: clip(a.category.slug, 120) } : null,
    author: a.author && clip(a.author.name, 120) ? { name: clip(a.author.name, 120) } : null,
    isFeatured: a.isFeatured === true,
    readingTimeMinutes: Number.isInteger(a.readingTimeMinutes) && a.readingTimeMinutes > 0 ? Math.min(a.readingTimeMinutes, 600) : null,
    publishedAt: a.publishedAt,
    updatedAt: isDate(a.updatedAt) ? a.updatedAt : a.publishedAt
  };
}

// ---------- Fetching ----------
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'SHEREBOY-TECH-LTD-Website/1.0' }, signal: controller.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`SHEREBOY BLOG returned an invalid response (HTTP ${res.status})`); }
    if (!res.ok || body.success === false) {
      throw new Error(`SHEREBOY BLOG responded with HTTP ${res.status}${body && body.message ? ` — ${String(body.message).slice(0, 120)}` : ''}`);
    }
    return { body, durationMs: Date.now() - started };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`SHEREBOY BLOG did not respond within ${Math.round(timeoutMs / 1000)} seconds`);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err.message)) throw new Error('SHEREBOY BLOG could not be reached');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchArticles() {
  const c = cfg();
  const url = `${c.apiBase}/api/public/articles?page=1&pageSize=${c.pageSize}`;
  let lastErr;
  // Up to 2 attempts: hosts that sleep when idle often fail the first call while waking
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { body, durationMs } = await fetchJson(url, c.timeoutMs);
      const list = body && body.data && Array.isArray(body.data.articles) ? body.data.articles : null;
      if (!list) throw new Error('SHEREBOY BLOG returned an unexpected response format');
      const articles = list.map(a => normaliseArticle(a, c)).filter(Boolean);
      const total = Number.isInteger(body.data.pagination && body.data.pagination.total) ? body.data.pagination.total : articles.length;
      return { articles, total, durationMs };
    } catch (err) {
      lastErr = err;
      if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

/** Fetches now (deduplicating concurrent calls). Never throws — records the error instead. */
function refresh() {
  if (state.inFlight) return state.inFlight;
  state.lastAttemptAt = Date.now();
  state.inFlight = fetchArticles()
    .then(({ articles, total, durationMs }) => {
      state.articles = articles;
      state.total = total;
      state.fetchedAt = Date.now();
      state.lastDurationMs = durationMs;
      state.lastError = null;
      return true;
    })
    .catch((err) => {
      state.lastError = err.message;
      state.lastErrorAt = Date.now();
      console.warn('[blogFeed] refresh failed:', err.message);
      return false;
    })
    .finally(() => { state.inFlight = null; });
  return state.inFlight;
}

/**
 * Returns the feed for visitors. Waits for the network only when there is no
 * usable cached copy; otherwise answers instantly and refreshes behind the scenes.
 */
async function getFeed() {
  const c = cfg();
  const age = Date.now() - state.fetchedAt;
  const hasCache = state.articles !== null;

  if (!hasCache || age > c.staleMaxMs) {
    await refresh();
  } else if (age > c.ttlMs) {
    refresh(); // background
  }

  const usableAge = Date.now() - state.fetchedAt;
  const usable = state.articles !== null && usableAge <= c.staleMaxMs;
  return {
    articles: usable ? state.articles : [],
    total: usable ? state.total : 0,
    status: !usable ? 'unavailable' : (state.lastError ? 'stale' : 'live'),
    fetchedAt: usable ? new Date(state.fetchedAt).toISOString() : null,
    blogUrl: c.publicUrl
  };
}

/** Cached articles only (no network) — for server-rendered metadata. */
function cachedArticles() {
  const fresh = state.articles !== null && Date.now() - state.fetchedAt <= cfg().staleMaxMs;
  return fresh ? state.articles : [];
}

/** Webhook / admin: drop one article immediately (e.g. unpublished), then refetch. */
function forget(slug) {
  if (state.articles && slug) state.articles = state.articles.filter(a => a.slug !== slug);
}

/** Admin connection check — live call to the blog's status endpoint. */
async function checkConnection() {
  const c = cfg();
  try {
    const { body, durationMs } = await fetchJson(`${c.apiBase}/api/public/status`, c.timeoutMs);
    const d = body.data || {};
    return { ok: true, responseMs: durationMs, publishedCount: Number.isInteger(d.publishedCount) ? d.publishedCount : null, lastUpdatedAt: isDate(d.lastUpdatedAt) ? d.lastUpdatedAt : null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function snapshot() {
  const c = cfg();
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    platform: 'SHEREBOY BLOG',
    blogUrl: c.publicUrl,
    apiUrl: `${c.apiBase}/api/public/articles`,
    cachedArticles: state.articles ? state.articles.length : 0,
    totalPublished: state.articles ? state.total : null,
    lastSuccessAt: iso(state.fetchedAt),
    lastAttemptAt: iso(state.lastAttemptAt),
    lastError: state.lastError,
    lastErrorAt: iso(state.lastErrorAt),
    lastDurationMs: state.lastDurationMs,
    cacheTtlSeconds: Math.round(c.ttlMs / 1000),
    staleMaxSeconds: Math.round(c.staleMaxMs / 1000),
    webhookConfigured: !!process.env.BLOG_WEBHOOK_SECRET
  };
}

let timer = null;
function startPeriodicRefresh() {
  if (timer) return;
  timer = setInterval(() => { refresh(); }, cfg().refreshIntervalMs);
  timer.unref();
  // Warm the cache shortly after boot so the first visitor doesn't wait
  setTimeout(() => refresh(), 3000).unref();
}

module.exports = { getFeed, cachedArticles, refresh, forget, checkConnection, snapshot, startPeriodicRefresh, normaliseArticle, _state: state };
