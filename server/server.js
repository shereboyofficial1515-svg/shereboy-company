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
const blogRoutes = require('./routes/blog');
const serviceRoutes = require('./routes/services');
const companyRoutes = require('./routes/company');
const aiChatRoutes = require('./routes/aiChat');
const dashboardRoutes = require('./routes/dashboard');
const uploadRoutes = require('./routes/upload');
const contactRoutes = require('./routes/contact');
const mediaRoutes = require('./routes/media');
const adminUserRoutes = require('./routes/adminUsers');
const seo = require('./seo');
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
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

app.use(compression());
// The site and its API share one origin, so cross-origin credentialed requests
// are refused unless an origin is explicitly listed in ALLOWED_ORIGINS.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// --- Sessions (HTTP-only secure cookies) ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'CHANGE_ME_dev_only_secret',
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
app.use('/api/blog', blogRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/ai/chat', aiChatLimiter, aiChatRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/admin', adminUserRoutes);

// Unknown API routes return JSON 404s (never the HTML app shell)
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// --- SEO: generated sitemap/robots + per-page meta for shareable URLs ---
app.get('/sitemap.xml', seo.sitemap);
app.get('/robots.txt', seo.robots);
app.get('/projects/:id', seo.projectPage);
app.get('/blog/:slug', seo.blogPage);

// --- Static frontend ---
app.use(express.static(path.join(__dirname, '..', 'public'), {
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

// Any other non-API, non-file route falls back to index.html for client-side routing
// (unknown /projects/:id or /blog/:slug also land here and show a friendly message).
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (req.path.includes('.')) return next(); // let static middleware / 404 handle real files
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- 404 for anything else (e.g. missing static files) ---
app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found.');
});

// --- Central error handler ---
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err.message);
  if (isProd) {
    res.status(500).json({ error: 'Something went wrong. Please try again later.' });
  } else {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.listen(PORT, () => {
  console.log(`SHEREBOY TECH LTD server running on port ${PORT}`);
});