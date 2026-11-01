// server/routes/blogFeed.js
// SHEREBOY BLOG integration. Read-only: this site never creates, edits or
// deletes articles — it only displays published summaries from SHEREBOY BLOG.
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const blogFeed = require('../blogFeed');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { createVerifier } = require('../webhookAuth');

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
const verifyWebhook = createVerifier({ secretEnv: 'BLOG_WEBHOOK_SECRET', timestampHeader: 'x-shereblog-timestamp', signatureHeader: 'x-shereblog-signature' });

router.post('/webhook', webhookLimiter, async (req, res) => {
  const check = verifyWebhook(req);
  if (!check.ok) return res.status(check.status).json({ error: check.error });

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
