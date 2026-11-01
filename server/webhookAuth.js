// server/webhookAuth.js
// Verifies signed "content changed" webhooks from partner platforms
// (SHEREBOY BLOG, SHEREBOY AFFILIATE CONCEPT). Each sender signs
// HMAC-SHA256 over "<unix timestamp>.<raw JSON body>" with a shared secret.
// Rejects: missing/forged signatures, tampered bodies, timestamps more than
// 5 minutes old (replays) and repeated deliveries of the same signature.
const crypto = require('crypto');

const MAX_SKEW_SECONDS = 300;

function createVerifier({ secretEnv, timestampHeader, signatureHeader }) {
  const seen = new Map(); // signature -> expiry

  return function verify(req) {
    const secret = process.env[secretEnv];
    if (!secret) return { ok: false, status: 503, error: 'Webhook is not configured.' };

    const timestamp = req.get(timestampHeader) || '';
    const given = (req.get(signatureHeader) || '').replace(/^sha256=/, '');
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!/^\d{9,11}$/.test(timestamp) || !(age <= MAX_SKEW_SECONDS) || !/^[a-f0-9]{64}$/.test(given) || !raw) {
      return { ok: false, status: 401, error: 'Invalid signature.' };
    }
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))) {
      return { ok: false, status: 401, error: 'Invalid signature.' };
    }
    const now = Date.now();
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (seen.has(given)) return { ok: false, status: 409, error: 'Duplicate delivery.' };
    seen.set(given, now + MAX_SKEW_SECONDS * 1000);
    return { ok: true };
  };
}

module.exports = { createVerifier };
