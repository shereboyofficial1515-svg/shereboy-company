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
const { aiChatLimiter } = require('./middleware/security');

const app = express();
const PORT = process.env.PORT || 10000;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);

// --- Security headers ---
app.use(helmet({
  contentSecurityPolicy: false // the admin/frontend load a couple of external assets; keep simple by default
}));

app.use(compression());
app.use(cors({ origin: true, credentials: true }));
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

// --- Static frontend ---
app.use(express.static(path.join(__dirname, '..', 'public')));

// robots.txt / sitemap.xml are plain files served from /public

// Admin SPA fallback (client-side auth check happens in admin.js)
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// Blog post pretty URLs: /blog/:slug -> served by public/index.html's router (vanilla JS)
// We just make sure any non-API, non-file route falls back to index.html for client-side routing.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (req.path.includes('.')) return next(); // let static middleware / 404 handle real files
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- 404 for anything else (e.g. missing static files) ---
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
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