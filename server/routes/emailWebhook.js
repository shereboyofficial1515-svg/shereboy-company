// server/routes/emailWebhook.js
// Delivery events from Resend, and an optional wake-up call for scheduled sends.
// Statistics only ever move because of a signed event from Resend.
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { mailEnv } = require('../mail/config');
const { markUndeliverable } = require('../mail/subscribers');
const { refreshStats, tick } = require('../mail/worker');
const { Resend } = require('resend');
const errorLog = require('../errorLog');

// Events can arrive out of order: a later state is never replaced by an earlier one
const RANK = { pending: 0, sending: 1, failed: 2, skipped: 2, accepted: 2, delayed: 3, delivered: 4, bounced: 5, complained: 6 };
const STATUS_FOR = { 'email.sent': 'accepted', 'email.delivery_delayed': 'delayed', 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed', 'email.suppressed': 'failed' };

const dirtyCampaigns = new Set();
let flushTimer = null;
function scheduleStats(campaignId) {
  dirtyCampaigns.add(campaignId);
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const ids = [...dirtyCampaigns];
    dirtyCampaigns.clear();
    for (const id of ids) await refreshStats(id).catch(() => {});
  }, 2000);
  flushTimer.unref();
}

function tagValue(tags, name) {
  if (Array.isArray(tags)) return (tags.find(t => t && t.name === name) || {}).value;
  return tags && tags[name];
}

async function findRecipient(data) {
  if (data.email_id) {
    const { data: row } = await supabase.from('email_campaign_recipients').select('*').eq('provider_id', data.email_id).maybeSingle();
    if (row) return row;
  }
  // The event can beat our own record of the send
  const campaignId = tagValue(data.tags, 'campaign_id');
  const to = Array.isArray(data.to) ? data.to[0] : data.to;
  if (campaignId && to) {
    const { data: row } = await supabase.from('email_campaign_recipients').select('*').eq('campaign_id', campaignId).eq('email', String(to).toLowerCase()).maybeSingle();
    return row || null;
  }
  return null;
}

async function applyEvent(type, data, occurredAt) {
  const recipient = await findRecipient(data);
  const to = String((Array.isArray(data.to) ? data.to[0] : data.to) || (recipient && recipient.email) || '').toLowerCase();

  if (recipient) {
    const update = { updated_at: new Date().toISOString() };
    if (data.email_id && !recipient.provider_id) update.provider_id = data.email_id;
    const next = STATUS_FOR[type];
    if (next && RANK[next] > (RANK[recipient.status] ?? 0)) update.status = next;
    if (type === 'email.delivered' && !recipient.delivered_at) update.delivered_at = occurredAt;
    if (type === 'email.opened' && !recipient.opened_at) update.opened_at = occurredAt;
    if (type === 'email.clicked' && !recipient.clicked_at) update.clicked_at = occurredAt;
    if (type === 'email.bounced') update.last_error = String((data.bounce && data.bounce.message) || 'Bounced').slice(0, 300);
    await supabase.from('email_campaign_recipients').update(update).eq('id', recipient.id);
    if (recipient.subscriber_id) await supabase.from('email_subscribers').update({ last_event: type.replace('email.', ''), last_email_at: occurredAt }).eq('id', recipient.subscriber_id);
    scheduleStats(recipient.campaign_id);
  } else if (to && type !== 'email.opened' && type !== 'email.clicked') {
    await supabase.from('email_subscribers').update({ last_event: type.replace('email.', ''), last_email_at: occurredAt }).eq('email', to);
  }

  // A temporary bounce may yet succeed; only a permanent one stops future email
  if (to && type === 'email.bounced' && !/transient|temporary/i.test((data.bounce && data.bounce.type) || '')) await markUndeliverable(to, 'bounced');
  if (to && type === 'email.complained') await markUndeliverable(to, 'complained');
  return recipient;
}

// POST /api/email/webhook
router.post('/webhook', async (req, res) => {
  const { webhookSecret } = mailEnv();
  if (!webhookSecret) return res.status(503).json({ error: 'Webhook is not configured.' });
  if (!req.rawBody) return res.status(400).json({ error: 'Invalid webhook.' });

  let event;
  try {
    // Verified against the raw bytes; the SDK needs no API key for this
    event = new Resend('verification-only').webhooks.verify({
      payload: req.rawBody.toString('utf8'),
      headers: { id: req.get('svix-id'), timestamp: req.get('svix-timestamp'), signature: req.get('svix-signature') },
      webhookSecret
    });
  } catch {
    return res.status(400).json({ error: 'Invalid webhook.' });
  }

  const key = req.get('svix-id');
  const type = String(event.type || '');
  const data = event.data || {};
  const occurredAt = Date.parse(data.created_at || event.created_at) ? new Date(data.created_at || event.created_at).toISOString() : new Date().toISOString();

  try {
    const { data: seen } = await supabase.from('email_events').select('id, processed_at').eq('event_key', key).maybeSingle();
    // Resend may repeat a delivery: it counts once
    if (seen && seen.processed_at) return res.json({ received: true, duplicate: true });

    const to = Array.isArray(data.to) ? data.to[0] : data.to;
    if (!seen) {
      const { error } = await supabase.from('email_events').insert({
        event_key: key, type, provider_id: data.email_id || null, email: to ? String(to).toLowerCase() : null,
        detail: type === 'email.bounced' ? String((data.bounce && data.bounce.type) || '').slice(0, 100) : null,
        occurred_at: occurredAt
      });
      if (error) {
        if (error.code === '23505') return res.json({ received: true, duplicate: true });
        throw new Error('Could not store the event');
      }
    }
    if (type.startsWith('email.')) {
      const recipient = await applyEvent(type, data, occurredAt);
      if (recipient) await supabase.from('email_events').update({ campaign_id: recipient.campaign_id }).eq('event_key', key);
    }
    await supabase.from('email_events').update({ processed_at: new Date().toISOString() }).eq('event_key', key);
    res.json({ received: true });
  } catch (err) {
    // A 500 makes Resend retry, and this event is not yet marked as processed
    errorLog.record('email', `Webhook: ${err.message}`);
    res.status(500).json({ error: 'Could not process the event.' });
  }
});

// POST /api/email/cron — lets an outside scheduler wake the site so that a scheduled
// campaign still goes out when free hosting has put the server to sleep.
router.post('/cron', async (req, res) => {
  const { cronSecret } = mailEnv();
  const given = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer /, ''));
  const expected = Buffer.from(cronSecret);
  if (!cronSecret || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return res.status(401).json({ error: 'Unauthorized.' });
  const ready = await tick();
  res.json({ ok: true, campaignsReady: ready });
});

module.exports = router;
