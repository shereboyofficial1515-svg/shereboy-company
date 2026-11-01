// server/affiliateFeed.js
// Reads products from SHEREBOY AFFILIATE CONCEPT (the single source of truth)
// through its read-only public API. Nothing is stored in this site's database —
// the catalogue lives only in a short-lived in-memory cache, and search,
// category filtering and pagination for visitors run against that cache.
//
// Sync strategy (same as the SHEREBOY BLOG feed):
//   * Fresh for AFFILIATE_CACHE_TTL_SECONDS (default 5 min); stale copies are
//     served instantly while a background refresh runs.
//   * A signed webhook from the affiliate platform triggers an immediate refresh.
//   * A periodic refresh runs as a fallback.
//   * If the platform is unreachable, the last good copy is used for at most
//     AFFILIATE_STALE_MAX_SECONDS (default 6 h) — never disabled/deleted
//     products indefinitely.

const serviceMonitor = require('./serviceMonitor');

const DEFAULT_URL = 'https://shereboyaffiliateconcept.shop';
const PAGE_SIZE = 48;   // the platform's maximum page size
const MAX_PAGES = 20;   // safety cap: up to 960 products

function cfg() {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const strip = (u) => String(u || '').trim().replace(/\/+$/, '');
  const apiBase = strip(process.env.AFFILIATE_API_BASE_URL) || DEFAULT_URL;
  return {
    apiBase,
    publicUrl: strip(process.env.AFFILIATE_PUBLIC_URL) || apiBase,
    ttlMs: num(process.env.AFFILIATE_CACHE_TTL_SECONDS, 300) * 1000,
    staleMaxMs: num(process.env.AFFILIATE_STALE_MAX_SECONDS, 6 * 3600) * 1000,
    timeoutMs: num(process.env.AFFILIATE_FETCH_TIMEOUT_MS, 10000),
    firstWaitMs: num(process.env.AFFILIATE_FIRST_WAIT_MS, 1500),
    refreshIntervalMs: num(process.env.AFFILIATE_REFRESH_INTERVAL_SECONDS, 900) * 1000
  };
}

const state = {
  products: null, fetchedAt: 0, lastAttemptAt: 0, lastError: null, lastErrorAt: 0, lastDurationMs: null, inFlight: null
};

// ---------- Validation (never trust remote JSON) ----------
const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function originOf(u) { try { return new URL(u).origin; } catch { return null; } }

function safeImage(raw, c) {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return u.toString();
    if (u.protocol === 'http:' && u.origin === originOf(c.publicUrl)) return u.toString(); // local development only
  } catch { /* invalid */ }
  return null;
}

/** Tracking links are kept exactly as supplied (all query parameters intact) when they are valid http(s) URLs. */
function verbatimHttpUrl(raw) {
  if (typeof raw !== 'string' || /\s/.test(raw) || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : null;
  } catch { return null; }
}

function normalise(p, c) {
  if (!p || typeof p !== 'object') return null;
  const slug = typeof p.slug === 'string' ? p.slug.trim() : '';
  const name = clip(p.name, 200);
  if (!SLUG_RE.test(slug) || !name) return null;

  // Destination: the product's page on SHEREBOY AFFILIATE CONCEPT (only ever that host);
  // if that is unusable, the partner tracking link exactly as supplied. A product without a
  // valid tracking link can't be bought anywhere, so it gets no active destination at all.
  const productUrl = verbatimHttpUrl(p.productUrl);
  const affiliateUrl = verbatimHttpUrl(p.affiliateUrl);
  const ownPage = affiliateUrl && productUrl && originOf(productUrl) === originOf(c.publicUrl) ? productUrl : null;

  const price = p.price && typeof p.price === 'object' ? p.price : {};
  const current = money(price.current);
  let previous = money(price.previous);
  if (previous === null || current === null || previous <= current) previous = null; // only genuine discounts
  const currency = /^[A-Z]{3}$/.test(price.currency) ? price.currency : 'NGN';
  const discountPercent = previous && Number.isFinite(price.discountPercent) ? Math.round(price.discountPercent) : (previous ? Math.round((1 - current / previous) * 100) : 0);

  const imageUrl = p.image && safeImage(p.image.url, c);
  const availability = ['in_stock', 'limited', 'out_of_stock'].includes(p.availability) ? p.availability : 'in_stock';
  return {
    slug,
    name,
    description: clip(p.description, 320),
    image: imageUrl ? { url: imageUrl, alt: clip(p.image.alt, 200) || name } : null,
    category: p.category && clip(p.category.name, 80) && SLUG_RE.test(p.category.slug || '') ? { name: clip(p.category.name, 80), slug: p.category.slug } : null,
    price: { current, previous, discountPercent, currency },
    isFeatured: p.isFeatured === true,
    isDeal: p.isDeal === true,
    availability,
    isAvailable: availability !== 'out_of_stock',
    url: ownPage || affiliateUrl || null,
    urlType: ownPage ? 'product-page' : (affiliateUrl ? 'partner-store' : null),
    affiliateUrl,
    addedAt: isDate(p.addedAt) ? p.addedAt : null,
    updatedAt: isDate(p.updatedAt) ? p.updatedAt : (isDate(p.addedAt) ? p.addedAt : null)
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
    try { body = JSON.parse(text); } catch { throw new Error(`SHEREBOY AFFILIATE CONCEPT returned an invalid response (HTTP ${res.status})`); }
    if (!res.ok || body.success === false) {
      throw new Error(`SHEREBOY AFFILIATE CONCEPT responded with HTTP ${res.status}${body && body.message ? ` — ${String(body.message).slice(0, 120)}` : ''}`);
    }
    return { body, durationMs: Date.now() - started };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`SHEREBOY AFFILIATE CONCEPT did not respond within ${Math.round(timeoutMs / 1000)} seconds`);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err.message)) throw new Error('SHEREBOY AFFILIATE CONCEPT could not be reached');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn) {
  try { return await fn(); } catch (err) {
    await new Promise(r => setTimeout(r, 1500)); // hosts that sleep when idle often fail the first call
    return fn();
  }
}

async function fetchCatalogue() {
  const c = cfg();
  const started = Date.now();
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // Only products the platform marks as available (out-of-stock items are not showcased)
    const { body } = await withRetry(() => fetchJson(`${c.apiBase}/api/public/products?page=${page}&pageSize=${PAGE_SIZE}&available=true`, c.timeoutMs));
    const list = body && body.data && Array.isArray(body.data.products) ? body.data.products : null;
    if (!list) throw new Error('SHEREBOY AFFILIATE CONCEPT returned an unexpected response format');
    all.push(...list);
    const totalPages = body.data.pagination && Number.isInteger(body.data.pagination.totalPages) ? body.data.pagination.totalPages : 1;
    if (page >= totalPages || !list.length) break;
  }
  const seen = new Set();
  const products = all.map(p => normalise(p, c)).filter(p => p && !seen.has(p.slug) && seen.add(p.slug));
  return { products, durationMs: Date.now() - started };
}

/** Fetches now (deduplicating concurrent calls). Never throws — records the error instead. */
function refresh() {
  if (state.inFlight) return state.inFlight;
  state.lastAttemptAt = Date.now();
  state.inFlight = fetchCatalogue()
    .then(({ products, durationMs }) => {
      state.products = products;
      state.fetchedAt = Date.now();
      state.lastDurationMs = durationMs;
      state.lastError = null;
      return true;
    })
    .catch((err) => {
      state.lastError = err.message;
      state.lastErrorAt = Date.now();
      console.warn('[affiliateFeed] refresh failed:', err.message);
      return false;
    })
    .finally(() => { state.inFlight = null; });
  return state.inFlight;
}

/**
 * The current catalogue. A visitor never waits for a sleeping platform: with no
 * usable copy it gets a moment to answer, then the service monitor fetches the
 * products once the platform is ready.
 */
async function getCatalogue() {
  const c = cfg();
  const age = Date.now() - state.fetchedAt;
  if (state.products === null || age > c.staleMaxMs) await Promise.race([refresh(), new Promise(r => setTimeout(r, c.firstWaitMs))]);
  else if (age > c.ttlMs) refresh(); // background

  const usable = state.products !== null && Date.now() - state.fetchedAt <= c.staleMaxMs;
  return {
    products: usable ? state.products : [],
    status: !usable ? (state.inFlight || serviceMonitor.feedHint('affiliate') === 'waking' ? 'waking' : 'unavailable') : (state.lastError ? 'stale' : 'live'),
    fetchedAt: usable ? new Date(state.fetchedAt).toISOString() : null,
    siteUrl: c.publicUrl
  };
}

/** Cached products only (no network) — for server-rendered pages. */
function cachedProducts() {
  const usable = state.products !== null && Date.now() - state.fetchedAt <= cfg().staleMaxMs;
  return usable ? state.products : [];
}

function categoriesOf(products) {
  const map = new Map();
  products.forEach(p => {
    if (!p.category) return;
    const entry = map.get(p.category.slug) || { ...p.category, count: 0 };
    entry.count += 1;
    map.set(p.category.slug, entry);
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Webhook: drop a deleted product at once, even before the refresh completes. */
function forget(slug) {
  if (state.products && slug) state.products = state.products.filter(p => p.slug !== slug);
}

async function checkConnection() {
  const c = cfg();
  try {
    const { body, durationMs } = await fetchJson(`${c.apiBase}/api/public/status`, c.timeoutMs);
    const d = body.data || {};
    const int = (v) => (Number.isInteger(v) ? v : null);
    return { ok: true, responseMs: durationMs, totalProducts: int(d.totalProducts), availableProducts: int(d.availableProducts), featuredProducts: int(d.featuredProducts) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function snapshot() {
  const c = cfg();
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const list = state.products || [];
  return {
    platform: 'SHEREBOY AFFILIATE CONCEPT',
    siteUrl: c.publicUrl,
    apiUrl: `${c.apiBase}/api/public/products`,
    cachedProducts: list.length,
    cachedFeatured: list.filter(p => p.isFeatured).length,
    productsWithoutImage: list.filter(p => !p.image).length,
    productsWithoutDestination: list.filter(p => !p.url).length,
    lastSuccessAt: iso(state.fetchedAt),
    lastAttemptAt: iso(state.lastAttemptAt),
    lastError: state.lastError,
    lastErrorAt: iso(state.lastErrorAt),
    lastDurationMs: state.lastDurationMs,
    cacheTtlSeconds: Math.round(c.ttlMs / 1000),
    webhookConfigured: !!process.env.AFFILIATE_WEBHOOK_SECRET
  };
}

let timer = null;
function startPeriodicRefresh() {
  if (timer) return;
  // Only while people are visiting, so an idle free Render service is allowed to sleep
  timer = setInterval(() => { if (serviceMonitor.hasRecentVisitors()) refresh(); }, cfg().refreshIntervalMs);
  timer.unref();
  // Fetch as soon as the platform confirms it is ready
  serviceMonitor.onReady('affiliate', () => { if (!state.fetchedAt || Date.now() - state.fetchedAt > cfg().ttlMs) refresh(); });
}

module.exports = { getCatalogue, cachedProducts, categoriesOf, refresh, forget, checkConnection, snapshot, startPeriodicRefresh, normalise, _state: state };
