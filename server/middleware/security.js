// server/middleware/security.js
const rateLimit = require('express-rate-limit');

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});

// Stricter limiter for the login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

// Stricter limiter for the AI chat endpoint (protects Gemini quota + prevents abuse)
const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are sending messages too quickly. Please wait a moment.' }
});

// File uploads are expensive (memory + storage) — cap them separately
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads. Please wait a few minutes and try again.' }
});

// The live-preview check makes an outbound request — keep it modest
const previewCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many preview checks. Please try again shortly.' }
});

// Basic string sanitizer — strips angle brackets to reduce XSS risk for
// any field that later gets rendered as HTML on the frontend.
function sanitizeString(value, maxLen = 2000) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>]/g, '').trim().slice(0, maxLen);
}

// URLs are rendered into href/src attributes, so escaping alone is not enough:
// only http(s) and site-relative paths are accepted (blocks javascript:, data:, etc).
function sanitizeUrl(value, maxLen = 1000) {
  const str = sanitizeString(value, maxLen);
  if (!str) return '';
  if (str.startsWith('/') && !str.startsWith('//')) return str;
  try {
    const u = new URL(str);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? str : '';
  } catch {
    return '';
  }
}

module.exports = {
  apiLimiter, loginLimiter, aiChatLimiter, uploadLimiter, previewCheckLimiter,
  sanitizeString, sanitizeUrl
};
