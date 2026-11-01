// server/mail/config.js
// Email configuration. Secrets stay in environment variables and are never
// returned to the browser; everyday settings live in the email_settings table.
const crypto = require('crypto');
const supabase = require('../database');
const { isMissingTableError } = require('../dbCompat');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const randomSecret = crypto.randomBytes(32).toString('hex');

function mailEnv() {
  const e = process.env;
  return {
    apiKey: e.RESEND_API_KEY || '',
    fromEmail: e.RESEND_FROM_EMAIL || e.RESEND_FROM || '',
    replyTo: e.RESEND_REPLY_TO || '',
    // Resend now calls Audiences "Segments"; both variable names are accepted
    segmentId: e.RESEND_SEGMENT_ID || e.RESEND_AUDIENCE_ID || '',
    webhookSecret: e.RESEND_WEBHOOK_SECRET || '',
    cronSecret: e.EMAIL_CRON_SECRET || '',
    baseUrl: (e.APP_BASE_URL || (e.SITE_URL || 'https://shereboytechltd.site').split(',')[0]).trim().replace(/\/+$/, ''),
    tokenSecret: e.EMAIL_TOKEN_SECRET || (e.SESSION_SECRET
      ? crypto.createHmac('sha256', e.SESSION_SECRET).update('email-tokens').digest('hex')
      : randomSecret),
    batchSize: Math.min(num(e.EMAIL_BATCH_SIZE, 50), 100), // Resend accepts at most 100 per call
    tickMs: num(e.EMAIL_WORKER_INTERVAL_MS, 1500),
    individualMax: num(e.EMAIL_INDIVIDUAL_MAX_RECIPIENTS, 10),
    individualDaily: num(e.EMAIL_INDIVIDUAL_DAILY_LIMIT, 50),
    largeAudience: num(e.EMAIL_LARGE_AUDIENCE_THRESHOLD, 25),
    testHourly: num(e.EMAIL_TEST_HOURLY_LIMIT, 20)
  };
}

const DEFAULT_SETTINGS = {
  sender_name: 'SHEREBOY TECH LTD',
  sender_email: '',
  reply_to: '',
  newsletter_description: 'Company news, product launches, technology insights and exclusive updates from SHEREBOY TECH LTD.',
  confirmation_subject: 'Please confirm your subscription to SHEREBOY TECH LTD updates',
  confirmation_intro: 'You asked to receive company news, product launches, technology insights and exclusive updates from SHEREBOY TECH LTD. Please confirm this was you.',
  confirmation_expiry_hours: 48,
  welcome_enabled: true,
  welcome_subject: 'Welcome to SHEREBOY TECH LTD updates',
  welcome_body: '<p>Thank you for confirming your subscription. We will send you company news, product launches and technology insights.</p><p>You can unsubscribe at any time using the link at the bottom of every email.</p>',
  footer_text: 'SHEREBOY TECH LTD',
  logo_url: '',
  contact_address: '',
  contact_email: '',
  contact_phone: ''
};

let cache = null;
let cachedAt = 0;

async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < 30000) return cache;
  const { data, error } = await supabase.from('email_settings').select('*').eq('id', 1).maybeSingle();
  if (error && !isMissingTableError(error)) throw new Error('Could not read email settings');
  const merged = { ...DEFAULT_SETTINGS };
  Object.entries(data || {}).forEach(([k, v]) => { if (v !== null && v !== '') merged[k] = v; });
  cache = merged;
  cachedAt = Date.now();
  return merged;
}

function forgetSettings() { cache = null; }

const addressOf = (from) => { const m = /<([^>]+)>/.exec(from || ''); return (m ? m[1] : from || '').trim().toLowerCase(); };
const domainOf = (address) => String(address || '').split('@')[1] || '';

/** The domain email may be sent from: the one configured on the server. */
function sendingDomain() {
  const env = mailEnv();
  if (env.fromEmail) return domainOf(addressOf(env.fromEmail));
  try { return new URL(env.baseUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Always the company's own sender identity, never a recipient's address. */
function fromHeader(settings) {
  const env = mailEnv();
  const address = settings.sender_email && domainOf(settings.sender_email.toLowerCase()) === sendingDomain()
    ? settings.sender_email
    : addressOf(env.fromEmail);
  if (!address) return '';
  const name = String(settings.sender_name || 'SHEREBOY TECH LTD').replace(/[<>"\r\n]/g, '').trim();
  return `${name} <${address}>`;
}

function replyToHeader(settings, override) {
  return override || settings.reply_to || mailEnv().replyTo || undefined;
}

/** What the admin page may see: whether things are set, never their values. */
function configStatus(settings) {
  const env = mailEnv();
  return {
    apiKeyConfigured: !!env.apiKey,
    webhookSecretConfigured: !!env.webhookSecret,
    segmentConfigured: !!env.segmentId,
    tokenSecretConfigured: !!(process.env.EMAIL_TOKEN_SECRET || process.env.SESSION_SECRET),
    cronSecretConfigured: !!env.cronSecret,
    sender: fromHeader(settings),
    sendingDomain: sendingDomain(),
    webhookUrl: `${env.baseUrl}/api/email/webhook`
  };
}

module.exports = { mailEnv, getSettings, forgetSettings, fromHeader, replyToHeader, configStatus, sendingDomain, domainOf, DEFAULT_SETTINGS };
