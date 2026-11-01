// server/routes/affiliateFeed.js
// SHEREBOY AFFILIATE CONCEPT integration. Read-only: this site never creates,
// edits or deletes products — it only displays what the affiliate platform
// publishes, and links each product to its own destination there.
const express = require('express');
const router = express.Router();
const { rateLimit } = require('../middleware/security');
const affiliateFeed = require('../affiliateFeed');
const serviceMonitor = require('../serviceMonitor');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { createVerifier } = require('../webhookAuth');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Reads from visitors (not the signed webhook or admin routes) count as activity
router.get(['/products', '/featured'], (req, res, next) => { serviceMonitor.touch(); next(); });

function intParam(value, name, min, max, fallback) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max) {
    const err = new Error(`"${name}" must be a whole number between ${min} and ${max}.`);
    err.status = 400;
    throw err;
  }
  return Number(value);
}

// Visitors always get an instant answer from the server's memory; revalidate on
// every load so a removed product never lingers in browser caches.
const noCache = (res, status) => res.set('Cache-Control', status === 'unavailable' ? 'no-store' : 'no-cache');

// GET /api/affiliate-feed/products?q=&category=&page=1&pageSize=12
router.get('/products', async (req, res) => {
  let page, pageSize;
  try {
    page = intParam(req.query.page, 'page', 1, 500, 1);
    pageSize = intParam(req.query.pageSize, 'pageSize', 1, 24, 12);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  if (category && !SLUG_RE.test(category)) return res.status(400).json({ error: 'Invalid category.' });
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 80) : '';

  const feed = await affiliateFeed.getCatalogue();
  let list = feed.products;
  if (category) list = list.filter(p => p.category && p.category.slug === category);
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    list = list.filter(p => {
      const hay = `${p.name} ${p.description} ${p.category ? p.category.name : ''}`.toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }
  const total = list.length;
  const start = (page - 1) * pageSize;
  noCache(res, feed.status);
  res.json({
    products: list.slice(start, start + pageSize),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), hasMore: start + pageSize < total },
    categories: affiliateFeed.categoriesOf(feed.products),
    catalogueSize: feed.products.length,
    status: feed.status,
    fetchedAt: feed.fetchedAt,
    siteUrl: feed.siteUrl
  });
});

// GET /api/affiliate-feed/featured?limit=4 — products the affiliate admin marked as
// featured; if there are fewer than `limit`, topped up with products marked as deals.
router.get('/featured', async (req, res) => {
  let limit;
  try { limit = intParam(req.query.limit, 'limit', 1, 12, 4); } catch (err) { return res.status(400).json({ error: err.message }); }
  const feed = await affiliateFeed.getCatalogue();
  const featured = feed.products.filter(p => p.isFeatured);
  const deals = feed.products.filter(p => !p.isFeatured && p.isDeal);
  noCache(res, feed.status);
  res.json({ products: featured.concat(deals).slice(0, limit), featuredCount: featured.length, status: feed.status, fetchedAt: feed.fetchedAt, siteUrl: feed.siteUrl });
});

// POST /api/affiliate-feed/webhook — signed notice from the affiliate platform that products changed
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
const verifyWebhook = createVerifier({ secretEnv: 'AFFILIATE_WEBHOOK_SECRET', timestampHeader: 'x-affiliate-timestamp', signatureHeader: 'x-affiliate-signature' });

router.post('/webhook', webhookLimiter, async (req, res) => {
  const check = verifyWebhook(req);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  const { event, slug } = req.body || {};
  if (event === 'product.deleted') affiliateFeed.forget(slug);
  const ok = await affiliateFeed.refresh();
  res.json({ received: true, refreshed: ok });
});

// GET /api/affiliate-feed/admin/status — signed-in admins
router.get('/admin/status', requireAuth, async (req, res) => {
  const connection = await affiliateFeed.checkConnection();
  res.set('Cache-Control', 'no-store');
  res.json({ ...affiliateFeed.snapshot(), connection });
});

// POST /api/affiliate-feed/admin/refresh — signed-in admins (CSRF-protected by requireAuth)
router.post('/admin/refresh', requireAuth, async (req, res) => {
  const ok = await affiliateFeed.refresh();
  logActivity(req.session.user, 'affiliate_feed_refreshed', ok ? 'Refreshed SHEREBOY AFFILIATE CONCEPT products' : 'SHEREBOY AFFILIATE CONCEPT refresh failed');
  const snap = affiliateFeed.snapshot();
  res.set('Cache-Control', 'no-store');
  res.status(ok ? 200 : 502).json({ refreshed: ok, ...(ok ? {} : { error: snap.lastError }), ...snap });
});

module.exports = router;
