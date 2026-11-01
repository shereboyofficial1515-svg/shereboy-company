// server/routes/system.js
// The admin System page. Administrators only (enforced here, not just in the
// browser): editors get a 403. Reports whether things are configured, never the
// values of any secret.
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth, requireRole } = require('../auth');
const { logActivity } = require('../activityLog');
const serviceMonitor = require('../serviceMonitor');
const blogFeed = require('../blogFeed');
const affiliateFeed = require('../affiliateFeed');
const seo = require('../seo');
const errorLog = require('../errorLog');
const { checkEmbeddable, clearPreviewCache } = require('../previewCheck');

router.use(requireAuth, requireRole('admin'));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function securityOverview() {
  const secret = process.env.SESSION_SECRET || '';
  const isProd = process.env.NODE_ENV === 'production';
  const check = (label, ok, detail) => ({ label, ok, detail });
  return [
    check('Production mode', isProd, isProd ? 'Secure cookies and generic error messages are on.' : 'NODE_ENV is not "production".'),
    check('Session secret', secret.length >= 32, secret.length >= 32 ? 'Configured.' : 'Missing or too short: set SESSION_SECRET to a long random value.'),
    check('Main administrator account', !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH), 'Stored as a bcrypt hash in environment variables.'),
    check('SHEREBOY BLOG webhook secret', !!process.env.BLOG_WEBHOOK_SECRET, process.env.BLOG_WEBHOOK_SECRET ? 'Configured.' : 'Not set: new articles appear at the next refresh instead of instantly.'),
    check('Affiliate webhook secret', !!process.env.AFFILIATE_WEBHOOK_SECRET, process.env.AFFILIATE_WEBHOOK_SECRET ? 'Configured.' : 'Not set: product changes appear at the next refresh instead of instantly.'),
    check('Sessions survive restarts', false, 'Sessions are held in memory: everyone signs in again after a restart. This is safe, but a little inconvenient on free hosting.')
  ];
}

// GET /api/system/overview
router.get('/overview', async (req, res) => {
  const [seoStatus, failedLogins, lastEvents] = await Promise.all([
    seo.status(),
    supabase.from('activity_log').select('id', { count: 'exact', head: true })
      .eq('action', 'login_failed').gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
    supabase.from('activity_log').select('action, details, created_at')
      .in('action', ['login', 'login_failed', 'admin_created', 'admin_updated', 'admin_deleted'])
      .order('created_at', { ascending: false }).limit(8)
  ]);
  const blog = blogFeed.snapshot();
  const aff = affiliateFeed.snapshot();
  res.json({
    security: {
      checks: securityOverview(),
      failedLogins24h: failedLogins.count || 0,
      recentEvents: lastEvents.data || []
    },
    services: serviceMonitor.snapshot(),
    feeds: {
      blog: { cachedItems: blog.cachedArticles, lastSuccessAt: blog.lastSuccessAt, lastError: blog.lastError, webhookConfigured: blog.webhookConfigured },
      affiliate: { cachedItems: aff.cachedProducts, lastSuccessAt: aff.lastSuccessAt, lastError: aff.lastError, webhookConfigured: aff.webhookConfigured }
    },
    seo: seoStatus,
    errors: errorLog.recent(20)
  });
});

// POST /api/system/services/check — re-check both services now
router.post('/services/check', async (req, res) => {
  serviceMonitor.wakeAll({ force: true });
  logActivity(req.session.user, 'services_checked', 'Started a connected service check');
  res.status(202).json({ started: true, services: serviceMonitor.snapshot() });
});

// GET /api/system/previews — can each published project be shown in the live preview?
// Separate from the overview because it contacts every project's website.
router.get('/previews', async (req, res) => {
  const { data, error } = await supabase.from('projects').select('id, title, live_url, preview_enabled').eq('published', true);
  if (error) return res.status(500).json({ error: 'Failed to load projects.' });
  if (req.query.fresh === '1') clearPreviewCache();
  const results = await Promise.all((data || []).map(async (p) => {
    if (!p.live_url) return { id: p.id, title: p.title, state: 'none', reason: 'No website address has been added.' };
    if (p.preview_enabled === false) return { id: p.id, title: p.title, url: p.live_url, state: 'disabled', reason: 'Live preview is switched off for this project.' };
    const check = await checkEmbeddable(p.live_url);
    const state = check.embeddable === true ? 'embeddable' : (check.embeddable === false ? 'blocked' : 'unknown');
    return { id: p.id, title: p.title, url: p.live_url, state, reason: check.reason || '' };
  }));
  res.json({ previews: results, checkedAt: new Date().toISOString() });
});

module.exports = router;
