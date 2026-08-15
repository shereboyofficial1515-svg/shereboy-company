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

// Basic string sanitizer — strips angle brackets to reduce XSS risk for
// any field that later gets rendered as HTML on the frontend.
function sanitizeString(value, maxLen = 2000) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>]/g, '').trim().slice(0, maxLen);
}

module.exports = { apiLimiter, loginLimiter, aiChatLimiter, sanitizeString };
