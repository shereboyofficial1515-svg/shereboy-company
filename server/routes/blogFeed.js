// server/routes/blogFeed.js
// SHEREBOY BLOG integration. Read-only: this site never creates, edits or
// deletes articles — it only displays published summaries from SHEREBOY BLOG.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const blogFeed = require('../blogFeed');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');

// GET /api/blog-feed — public
router.get('/', async (req, res) => {
  const feed = await blogFeed.getFeed();
  // Revalidate on every load (cheap 304 via ETag): the server answers from memory, and an
  // unpublished article must not linger in visitors' browser caches
  res.set('Cache-Control', feed.status === 'unavailable' ? 'no-store' : 'no-cache');
  res.json(feed);
});

// POST /api/blog-feed/webhook — called by SHEREBOY BLOG when published content changes.
// Signed with HMAC-SHA256 over "<timestamp>.<raw body>" using BLOG_WEBHOOK_SECRET.
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
const MAX_SKEW_SECONDS = 300;
const seen = new Map(); // signature -> expiry, prevents replaying the same call

router.post('/webhook', webhookLimiter, async (req, res) => {
  const secret = process.env.BLOG_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook is not configured.' });

  const timestamp = req.get('x-shereblog-timestamp') || '';
  const given = (req.get('x-shereblog-signature') || '').replace(/^sha256=/, '');
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!/^\d{9,11}$/.test(timestamp) || !(age <= MAX_SKEW_SECONDS) || !/^[a-f0-9]{64}$/.test(given) || !raw) {
    return res.status(401).json({ error: 'Invalid signature.' });
  }
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))) {
    return res.status(401).json({ error: 'Invalid signature.' });
  }
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (seen.has(given)) return res.status(409).json({ error: 'Duplicate delivery.' });
  seen.set(given, now + MAX_SKEW_SECONDS * 1000);

  const { event, slug } = req.body || {};
  // Remove an unpublished/deleted article at once, even if the refresh below fails
  if (event === 'article.unpublished' || event === 'article.deleted') blogFeed.forget(slug);
  const ok = await blogFeed.refresh();
  res.json({ received: true, refreshed: ok });
});

// GET /api/blog-feed/admin/status — signed-in admins
router.get('/admin/status', requireAuth, async (req, res) => {
  const connection = await blogFeed.checkConnection();
  res.set('Cache-Control', 'no-store');
  res.json({ ...blogFeed.snapshot(), connection });
});

// POST /api/blog-feed/admin/refresh — signed-in admins (CSRF-protected by requireAuth)
router.post('/admin/refresh', requireAuth, async (req, res) => {
  const ok = await blogFeed.refresh();
  logActivity(req.session.user, 'blog_feed_refreshed', ok ? 'Refreshed SHEREBOY BLOG articles' : 'SHEREBOY BLOG refresh failed');
  res.set('Cache-Control', 'no-store');
  const snap = blogFeed.snapshot();
  res.status(ok ? 200 : 502).json({ refreshed: ok, ...(ok ? {} : { error: snap.lastError }), ...snap });
});

module.exports = router;
