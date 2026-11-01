// server/routes/newsletter.js
// Public newsletter endpoints: subscribe, confirm, unsubscribe and one-click
// unsubscribe. Replies never reveal whether an address is subscribed.
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { rateLimit, sanitizeString } = require('../middleware/security');
const { isMissingTableError } = require('../dbCompat');
const { getSettings, fromHeader, replyToHeader } = require('../mail/config');
const { getResend } = require('../mail/resendClient');
const { buildMessage, esc } = require('../mail/render');
const { newConfirmationToken, hashToken, confirmUrl, unsubscribeUrl, unsubscribeHeaders, readUnsubscribeToken, maskEmail } = require('../mail/tokens');
const { normalizeEmail, suppressionOf, unsubscribe, recordEvent, syncContact } = require('../mail/subscribers');
const errorLog = require('../errorLog');

const SOURCES = ['homepage', 'footer', 'about', 'services', 'projects', 'project', 'contact', 'affiliate', 'other'];
const RESEND_AFTER_MS = 10 * 60 * 1000;
const CONSENT_TEXT = 'Subscribed to company news, product launches, technology insights and exclusive updates from SHEREBOY TECH LTD through the website form, with the option to unsubscribe at any time.';
const CHECK_INBOX = 'Almost there. Please check your inbox and click the link to confirm your subscription.';

const subscribeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } });
const tokenLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } });

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

async function sendConfirmation(email, token, settings) {
  const resend = getResend();
  const from = fromHeader(settings);
  if (!resend || !from) throw new Error('Email sending is not configured');
  const hours = settings.confirmation_expiry_hours;
  const link = confirmUrl(token);
  const { html, text } = buildMessage({
    subject: settings.confirmation_subject,
    preheader: 'One click to confirm your subscription',
    bodyHtml: `<h1>Confirm your subscription</h1><p>${esc(settings.confirmation_intro)}</p><p><a class="email-btn" href="${esc(link)}">Confirm my subscription</a></p><p>This link expires in ${hours} hours and works once. If you did not ask for this, ignore this email and you will not be subscribed.</p>`,
    settings,
    footerNote: 'You are receiving this one-time message because this address was entered on the SHEREBOY TECH LTD website.'
  });
  const { error } = await resend.emails.send({
    from, to: [email], subject: settings.confirmation_subject, html, text,
    tags: [{ name: 'kind', value: 'confirmation' }]
  }, { idempotencyKey: `confirm-${hashToken(token).slice(0, 40)}` });
  if (error) throw new Error(error.message || 'Resend rejected the message');
}

// POST /api/newsletter/subscribe
router.post('/subscribe', subscribeLimiter, async (req, res) => {
  const { email: rawEmail, first_name, source, consent, website } = req.body || {};
  // Bots fill the hidden field; they get the normal reply and nothing happens
  if (website) return res.json({ success: true, message: CHECK_INBOX });
  const email = normalizeEmail(rawEmail);
  if (!email) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (consent !== true) return res.status(400).json({ error: 'Please agree to receive our updates before subscribing.' });

  const { data: existing, error } = await supabase.from('email_subscribers').select('*').eq('email', email).maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return res.status(503).json({ error: 'Our newsletter is not open yet. Please check back soon.' });
    errorLog.record('email', 'Subscribe: could not read subscribers');
    return res.status(500).json({ error: 'We could not complete your subscription. Please try again.' });
  }

  // Already confirmed: nothing to send. Same reply, so this can't be used to test addresses.
  if (existing && existing.status === 'active') return res.json({ success: true, message: CHECK_INBOX });
  // Bounced or complained: never mailed again from a form that anyone can fill in
  const suppression = await suppressionOf(email);
  if (suppression && suppression.reason !== 'unsubscribed') return res.json({ success: true, message: CHECK_INBOX });
  // Stops this form being used to flood someone's inbox
  if (existing && existing.confirmation_sent_at && Date.now() - Date.parse(existing.confirmation_sent_at) < RESEND_AFTER_MS) {
    return res.json({ success: true, message: CHECK_INBOX });
  }

  try {
    const settings = await getSettings();
    const { token, hash } = newConfirmationToken();
    const nowIso = new Date().toISOString();
    const fields = {
      confirmation_token_hash: hash,
      confirmation_expires_at: new Date(Date.now() + settings.confirmation_expiry_hours * 3600 * 1000).toISOString(),
      consent_text: CONSENT_TEXT,
      signup_source: SOURCES.includes(source) ? source : 'other',
      updated_at: nowIso
    };
    const name = sanitizeString(first_name, 80);
    if (name) fields.first_name = name;
    // Someone who unsubscribed keeps that status until they confirm again themselves
    const write = existing
      ? await supabase.from('email_subscribers').update({ ...fields, ...(existing.status === 'unsubscribed' ? {} : { status: 'pending', consent_status: 'requested' }) }).eq('id', existing.id).select('id').single()
      : await supabase.from('email_subscribers').insert({ email, status: 'pending', consent_status: 'requested', ...fields }).select('id').single();
    if (write.error) {
      if (write.error.code === '23505') return res.json({ success: true, message: CHECK_INBOX }); // two requests at once
      throw new Error('Could not save the subscription');
    }
    await sendConfirmation(email, token, settings);
    await supabase.from('email_subscribers').update({ confirmation_sent_at: new Date().toISOString() }).eq('id', write.data.id);
    res.json({ success: true, message: CHECK_INBOX });
  } catch (err) {
    errorLog.record('email', `Subscribe: ${err.message}`);
    console.error('[newsletter] subscribe failed:', err.message);
    res.status(502).json({ error: 'We could not send your confirmation email just now. Please try again shortly.' });
  }
});

async function findByToken(token) {
  if (typeof token !== 'string' || !token || token.length > 200) return null;
  const { data } = await supabase.from('email_subscribers').select('*').eq('confirmation_token_hash', hashToken(token)).maybeSingle();
  return data || null;
}

const tokenExpired = (s) => !s.confirmation_expires_at || Date.parse(s.confirmation_expires_at) < Date.now();
const INVALID_LINK = 'This confirmation link is invalid or has already been used.';
const EXPIRED_LINK = 'This confirmation link has expired. Please subscribe again to get a new one.';

// GET /api/newsletter/confirm-info?token= — shows which address is being confirmed. Changes nothing.
router.get('/confirm-info', tokenLimiter, async (req, res) => {
  const subscriber = await findByToken(req.query.token);
  if (!subscriber) return res.status(404).json({ error: INVALID_LINK });
  if (tokenExpired(subscriber)) return res.status(410).json({ error: EXPIRED_LINK });
  res.json({ email: maskEmail(subscriber.email) });
});

// POST /api/newsletter/confirm — a button press, not the link itself, because
// email security scanners open links automatically.
router.post('/confirm', tokenLimiter, async (req, res) => {
  const { token } = req.body || {};
  const subscriber = await findByToken(token);
  if (!subscriber) return res.status(404).json({ error: INVALID_LINK });
  if (tokenExpired(subscriber)) return res.status(410).json({ error: EXPIRED_LINK });
  const suppression = await suppressionOf(subscriber.email);
  if (suppression && suppression.reason !== 'unsubscribed') return res.status(404).json({ error: INVALID_LINK });

  const nowIso = new Date().toISOString();
  // Conditional on the token, so a second press can't succeed
  const { data: updated, error } = await supabase.from('email_subscribers')
    .update({ status: 'active', consent_status: 'confirmed', consent_timestamp: nowIso, confirmed_at: nowIso, unsubscribed_at: null, unsubscribe_source: null, confirmation_token_hash: null, confirmation_expires_at: null, resend_sync_needed: true, updated_at: nowIso })
    .eq('id', subscriber.id).eq('confirmation_token_hash', hashToken(token)).select('*');
  if (error) return res.status(500).json({ error: 'We could not confirm your subscription. Please try again.' });
  if (!updated || !updated.length) return res.status(404).json({ error: INVALID_LINK });
  const active = updated[0];

  // Their own fresh, confirmed choice is what lifts an earlier unsubscribe
  if (suppression) await supabase.from('email_suppressions').delete().eq('email', active.email).eq('reason', 'unsubscribed');
  await recordEvent({ type: 'local.confirmed', email: active.email, detail: active.signup_source });
  syncContact(active).catch(() => {});
  sendWelcome(active).catch((err) => errorLog.record('email', `Welcome email: ${err.message}`));
  res.json({ success: true, message: 'Your subscription is confirmed. Thank you!' });
});

async function sendWelcome(subscriber) {
  const settings = await getSettings();
  const resend = getResend();
  const from = fromHeader(settings);
  if (!settings.welcome_enabled || !resend || !from) return;
  const { html, text } = buildMessage({
    subject: settings.welcome_subject,
    bodyHtml: settings.welcome_body,
    settings,
    firstName: subscriber.first_name,
    unsubscribeUrl: unsubscribeUrl(subscriber.email),
    footerNote: 'You are receiving this because you confirmed your subscription to updates from SHEREBOY TECH LTD.'
  });
  const replyTo = replyToHeader(settings);
  const { error } = await resend.emails.send({
    from, to: [subscriber.email], subject: settings.welcome_subject, html, text,
    ...(replyTo ? { replyTo } : {}),
    headers: unsubscribeHeaders(subscriber.email),
    tags: [{ name: 'kind', value: 'welcome' }]
  }, { idempotencyKey: `welcome-${subscriber.id}-${subscriber.confirmed_at}` });
  if (error) throw new Error(error.message);
}

// GET /api/newsletter/unsubscribe-info?token=
router.get('/unsubscribe-info', tokenLimiter, (req, res) => {
  const email = readUnsubscribeToken(req.query.token);
  if (!email) return res.status(400).json({ error: 'This unsubscribe link is not valid.' });
  res.json({ email: maskEmail(email) });
});

// POST /api/newsletter/unsubscribe — no sign-in needed
router.post('/unsubscribe', tokenLimiter, async (req, res) => {
  const email = readUnsubscribeToken((req.body || {}).token);
  if (!email) return res.status(400).json({ error: 'This unsubscribe link is not valid.' });
  try {
    await unsubscribe(email, 'unsubscribe page');
    res.json({ success: true, message: 'You have been unsubscribed. You will not receive any more marketing emails from us.' });
  } catch (err) {
    errorLog.record('email', `Unsubscribe: ${err.message}`);
    res.status(500).json({ error: 'We could not complete that. Please try again, or email us and we will remove you.' });
  }
});

// POST /api/newsletter/one-click — RFC 8058: mail apps call this directly, so it
// takes no cookies or CSRF token. The signed token in the address is the proof.
router.post('/one-click', async (req, res) => {
  const email = readUnsubscribeToken(req.query.token);
  if (!email) return res.status(400).type('text/plain').send('Invalid link.');
  try {
    await unsubscribe(email, 'one-click');
    res.status(200).type('text/plain').send('Unsubscribed.');
  } catch (err) {
    errorLog.record('email', `One-click unsubscribe: ${err.message}`);
    res.status(500).type('text/plain').send('Please try again.');
  }
});

module.exports = router;
