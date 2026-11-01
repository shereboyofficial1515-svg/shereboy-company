// server/mail/subscribers.js
// Subscriber state changes, in one place so that every path (the unsubscribe
// page, one-click, webhooks, the admin area) follows the same rules.
const supabase = require('../database');
const { mailEnv } = require('./config');
const { getResend } = require('./resendClient');
const errorLog = require('../errorLog');

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

async function suppressionOf(email) {
  const { data } = await supabase.from('email_suppressions').select('email, reason').eq('email', email).maybeSingle();
  return data || null;
}

async function recordEvent({ key, type, email, providerId, campaignId, detail }) {
  await supabase.from('email_events').insert({
    event_key: key || `local:${type}:${email}:${Date.now()}`,
    type,
    email: email || null,
    provider_id: providerId || null,
    campaign_id: campaignId || null,
    detail: detail ? String(detail).slice(0, 300) : null,
    occurred_at: new Date().toISOString(),
    processed_at: new Date().toISOString()
  });
}

/** Adds an address to the never-mail list. A complaint or bounce is never downgraded. */
async function suppress(email, reason, source) {
  const existing = await suppressionOf(email);
  if (existing) {
    if (existing.reason === 'unsubscribed' && reason !== 'unsubscribed') {
      await supabase.from('email_suppressions').update({ reason, source }).eq('email', email);
    }
    return;
  }
  const { error } = await supabase.from('email_suppressions').insert({ email, reason, source });
  if (error && error.code !== '23505') throw new Error('Could not record the suppression');
}

/** Tells Resend about the contact's state. Never blocks the visitor: failures retry later. */
async function syncContact(subscriber) {
  const resend = getResend();
  if (!resend) return false;
  const unsubscribed = subscriber.status !== 'active';
  try {
    const { segmentId } = mailEnv();
    let contactId = subscriber.resend_contact_id;
    if (!contactId && !unsubscribed) {
      const { data, error } = await resend.contacts.create({
        email: subscriber.email,
        ...(subscriber.first_name ? { firstName: subscriber.first_name } : {}),
        unsubscribed: false,
        ...(segmentId ? { segments: [{ id: segmentId }] } : {})
      });
      // Already known to Resend: fall through to the update below
      if (error && error.statusCode !== 409 && !/already exists/i.test(error.message || '')) throw new Error(error.message);
      contactId = data && data.id;
      if (error) {
        const updated = await resend.contacts.update({ email: subscriber.email, unsubscribed: false });
        if (updated.error) throw new Error(updated.error.message);
      }
    } else {
      const { error } = await resend.contacts.update({ email: subscriber.email, unsubscribed });
      // Nothing to update if Resend never knew this contact
      if (error && error.statusCode !== 404) throw new Error(error.message);
    }
    await supabase.from('email_subscribers').update({ resend_sync_needed: false, ...(contactId ? { resend_contact_id: contactId } : {}) }).eq('id', subscriber.id);
    return true;
  } catch (err) {
    errorLog.record('email', `Resend contact sync failed: ${err.message}`);
    await supabase.from('email_subscribers').update({ resend_sync_needed: true }).eq('id', subscriber.id);
    return false;
  }
}

/**
 * Stops future email to an address: updates the subscriber, adds the suppression
 * and keeps a record of the event. Works for any address, subscribed or not.
 */
async function unsubscribe(email, source) {
  const now = new Date().toISOString();
  await suppress(email, 'unsubscribed', source);
  const { data: rows } = await supabase.from('email_subscribers')
    .update({ status: 'unsubscribed', consent_status: 'withdrawn', unsubscribed_at: now, unsubscribe_source: source, confirmation_token_hash: null, confirmation_expires_at: null, updated_at: now, resend_sync_needed: true })
    .eq('email', email).in('status', ['pending', 'active', 'suppressed']).select('*');
  await recordEvent({ type: 'local.unsubscribed', email, detail: source });
  if (rows && rows[0]) syncContact(rows[0]).catch(() => {});
}

/** After a permanent bounce or a complaint. Those addresses are never mailed again. */
async function markUndeliverable(email, reason) {
  await suppress(email, reason, 'webhook');
  const { data: rows } = await supabase.from('email_subscribers')
    .update({ status: reason, last_event: reason, confirmation_token_hash: null, confirmation_expires_at: null, updated_at: new Date().toISOString(), resend_sync_needed: true })
    .eq('email', email).select('*');
  if (rows && rows[0]) syncContact(rows[0]).catch(() => {});
}

module.exports = { normalizeEmail, suppressionOf, suppress, unsubscribe, markUndeliverable, recordEvent, syncContact };
