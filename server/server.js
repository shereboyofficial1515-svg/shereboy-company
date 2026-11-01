// server/server.js
// SHEREBOY TECH LTD — main server entry point.

require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const { apiLimiter } = require('./middleware/security');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const reviewRoutes = require('./routes/reviews');
const blogFeedRoutes = require('./routes/blogFeed');
const blogFeed = require('./blogFeed');
const affiliateFeedRoutes = require('./routes/affiliateFeed');
const affiliateFeed = require('./affiliateFeed');
const serviceRoutes = require('./routes/services');
const companyRoutes = require('./routes/company');
const aiChatRoutes = require('./routes/aiChat');
const dashboardRoutes = require('./routes/dashboard');
const uploadRoutes = require('./routes/upload');
const contactRoutes = require('./routes/contact');
const mediaRoutes = require('./routes/media');
const adminUserRoutes = require('./routes/adminUsers');
const systemRoutes = require('./routes/system');
const seo = require('./seo');
const crypto = require('crypto');
const serviceMonitor = require('./serviceMonitor');
const errorLog = require('./errorLog');
const { aiChatLimiter } = require('./middleware/security');

const app = express();
const PORT = process.env.PORT || 10000;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);

// --- Security headers ---
// Project thumbnails, the founder photo and the CAC certificate can be hosted
// on any https image host the admin chooses, and live project previews frame
// external https sites — so img-src / frame-src allow https:, while scripts,
// API calls and forms stay locked to this origin.
const supabaseOrigin = (() => { try { return new URL(process.env.SUPABASE_URL).origin; } catch { return null; } })();
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:', 'https:', supabaseOrigin].filter(Boolean),
      'frame-src': ["'self'", 'https:', 'blob:', supabaseOrigin].filter(Boolean),
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      'upgrade-insecure-requests': isProd ? [] : null
    }
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true }
}));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()');
  // Private areas stay out of search results (robots.txt alone is not enough for that)
  if (req.path === '/admin' || req.path.startsWith('/admin/') || req.path.startsWith('/api/')) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(compression());
// The site and its API share one origin, so cross-origin credentialed requests
// are refused unless an origin is explicitly listed in ALLOWED_ORIGINS.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false, credentials: true }));
// rawBody is kept so the SHEREBOY BLOG webhook signature can be verified byte-for-byte
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// --- Sessions (HTTP-only secure cookies) ---
// Without a configured secret, a random one is used for this run: sessions end at
// restart, but nobody can forge a cookie using a value published in the source code.
if (!process.env.SESSION_SECRET) {
  const message = 'SESSION_SECRET is not set; using a temporary random secret for this run.';
  if (isProd) { console.error(`[server] ${message}`); errorLog.record('server', message); }
}
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  }
}));

// --- General API rate limiting ---
app.use('/api', apiLimiter);

// --- API routes ---
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/reviews', reviewRoutes);
// Articles come from SHEREBOY BLOG (read-only); the old internal /api/blog CMS is retired
app.use('/api/blog-feed', blogFeedRoutes);
// Products come from SHEREBOY AFFILIATE CONCEPT (read-only)
app.use('/api/affiliate-feed', affiliateFeedRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/ai/chat', aiChatLimiter, aiChatRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/admin', adminUserRoutes);
app.use('/api/system', systemRoutes);

// Unknown API routes return JSON 404s (never the HTML app shell)
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// --- SEO: generated sitemap/robots + per-page meta for shareable URLs ---
app.get('/sitemap.xml', seo.sitemap);
app.get('/robots.txt', seo.robots);
// One address per page: drop trailing slashes, and never serve the raw page template
app.get(/^\/(about|services|projects|contact|affiliate-products)\/$/, (req, res) => res.redirect(301, req.path.slice(0, -1) + (req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '')));
app.get('/index.html', (req, res) => res.redirect(301, '/'));
// A page view starts waking SHEREBOY BLOG and SHEREBOY AFFILIATE CONCEPT in the
// background. It returns immediately: pages never wait for those services.
const pageRoute = [serviceMonitor.onPageView];
app.get('/', pageRoute, seo.staticPage('home'));
app.get('/about', pageRoute, seo.staticPage('about'));
app.get('/services', pageRoute, seo.staticPage('services'));
app.get('/projects', pageRoute, seo.staticPage('projects'));
app.get('/contact', pageRoute, seo.staticPage('contact'));
app.get('/affiliate-products', pageRoute, seo.staticPage('affiliate'));
app.get('/projects/:id', pageRoute, seo.projectPage);
// Old internal article URLs: articles now live on SHEREBOY BLOG — send visitors to the Insights section
app.get(['/blog', '/blog/:slug'], (req, res) => res.redirect(301, '/#insights'));

// --- Static frontend ---
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: false,
  setHeaders(res, filePath) {
    // HTML/JS/CSS revalidate on every load so deploys show up immediately;
    // images and fonts can be cached for a week.
    if (/\.(html|js|css|xml|txt)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));

// Admin SPA fallback (client-side auth check happens in admin.js)
app.get(['/admin', '/admin/*'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// --- A real 404: unknown pages are not reported to search engines as valid pages ---
app.get('*', (req, res, next) => {
  if (req.path.includes('.')) return next(); // missing files get the plain response below
  seo.notFound(req, res).catch(next);
});
app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found.');
});

// --- Central error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Mistakes in the request itself (bad JSON, too large) are the client's to fix
  if (err.status >= 400 && err.status < 500) {
    const messages = { 400: 'The request could not be understood.', 413: 'That request is too large.' };
    return res.status(err.status).json({ error: messages[err.status] || 'The request could not be completed.' });
  }
  console.error('[server] Unhandled error:', err.message);
  errorLog.record('server', err.message, { method: req.method, path: req.path });
  if (isProd) {
    res.status(500).json({ error: 'Something went wrong. Please try again later.' });
  } else {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

process.on('unhandledRejection', (reason) => {
  const message = reason && reason.message ? reason.message : String(reason);
  console.error('[server] Unhandled rejection:', message);
  errorLog.record('server', message);
});

app.listen(PORT, () => {
  blogFeed.startPeriodicRefresh();
  affiliateFeed.startPeriodicRefresh();
  seo.refreshSiteData();
  console.log(`SHEREBOY TECH LTD server running on port ${PORT}`);
});