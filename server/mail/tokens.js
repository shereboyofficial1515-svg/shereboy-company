// server/mail/tokens.js
// Confirmation tokens are random and only their hash is stored, so a database
// leak can't be used to confirm anyone. Unsubscribe tokens are signed instead,
// because old emails must keep working without storing anything per message.
const crypto = require('crypto');
const { mailEnv } = require('./config');

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const sign = (v) => crypto.createHmac('sha256', mailEnv().tokenSecret).update(v).digest('base64url');

function newConfirmationToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

const hashToken = sha256;

function unsubscribeToken(email) {
  const body = Buffer.from(String(email).toLowerCase()).toString('base64url');
  return `${body}.${sign(`unsubscribe:${body}`)}`;
}

/** Returns the email address, or null if the token isn't genuine. */
function readUnsubscribeToken(token) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(`unsubscribe:${body}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return Buffer.from(body, 'base64url').toString('utf8');
}

const confirmUrl = (token) => `${mailEnv().baseUrl}/newsletter/confirm?token=${encodeURIComponent(token)}`;
const unsubscribeUrl = (email) => `${mailEnv().baseUrl}/newsletter/unsubscribe?token=${encodeURIComponent(unsubscribeToken(email))}`;
const oneClickUrl = (email) => `${mailEnv().baseUrl}/api/newsletter/one-click?token=${encodeURIComponent(unsubscribeToken(email))}`;

/** One-click unsubscribe headers (RFC 8058): mail apps POST to the https address. */
function unsubscribeHeaders(email) {
  return {
    'List-Unsubscribe': `<${oneClickUrl(email)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  };
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return '';
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(name.length - 1, 2))}@${domain}`;
}

module.exports = { newConfirmationToken, hashToken, unsubscribeToken, readUnsubscribeToken, confirmUrl, unsubscribeUrl, oneClickUrl, unsubscribeHeaders, maskEmail };
