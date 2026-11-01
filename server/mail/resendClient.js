// server/mail/resendClient.js
// The only place that creates the Resend client. The API key stays on the server.
const { Resend } = require('resend');
const { mailEnv } = require('./config');

let client = null;
let clientKey = '';

function getResend() {
  const { apiKey } = mailEnv();
  if (!apiKey) return null;
  if (!client || clientKey !== apiKey) {
    client = new Resend(apiKey);
    clientKey = apiKey;
  }
  return client;
}

/** How to react to a Resend error. */
function classifyError(error) {
  const name = error && error.name;
  const status = error && error.statusCode;
  if (name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded') return 'quota';
  if (status === 429 || name === 'rate_limit_exceeded') return 'rate';
  if (name === 'concurrent_idempotent_requests' || name === 'resource_locked') return 'rate';
  if (status === 401 || status === 403) return 'account'; // bad key, unverified domain, testing mode
  if (status === 400 || status === 404 || status === 405 || status === 409 || status === 422) return 'permanent';
  return 'transient'; // 5xx or no response: Resend may or may not have accepted it
}

module.exports = { getResend, classifyError };
