// server/mail/worker.js
// Sends campaigns in the background, from the database, so that no email is sent
// inside a web request and a restart loses nothing. Each tick sends one batch.
//
// Duplicate protection: every recipient is claimed with a batch key before the
// call, and that key becomes Resend's Idempotency-Key. If the server dies or the
// network drops mid-call, the same batch is resent with the same key, and Resend
// returns the original result instead of sending again. Keys last 24 hours, so a
// claim older than that is marked failed rather than risking a second email.
const crypto = require('crypto');
const supabase = require('../database');
const { mailEnv, getSettings, fromHeader, replyToHeader } = require('./config');
const { getResend, classifyError } = require('./resendClient');
const { buildMessage } = require('./render');
const { unsubscribeUrl, unsubscribeHeaders } = require('./tokens');
const { syncContact } = require('./subscribers');
const { isMissingTableError } = require('../dbCompat');
const errorLog = require('../errorLog');

const STALE_CLAIM_MS = 2 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 23 * 3600 * 1000;
const MAX_ATTEMPTS = 6;
const PAGE = 500;

const now = () => new Date().toISOString();
const later = (ms) => new Date(Date.now() + ms).toISOString();
const backoffMs = (n) => { const c = Math.min(5 * 60 * 1000, 2000 * (2 ** n)); return Math.round(c / 2 + Math.random() * (c / 2)); };

const STAT_STATUSES = ['pending', 'sending', 'accepted', 'delayed', 'delivered', 'bounced', 'complained', 'failed', 'skipped'];

/** Real counts from the recipient records. "accepted" only means Resend took the message. */
async function computeStats(campaignId) {
  const count = (build) => build(supabase.from('email_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId)).then(r => r.count || 0);
  const entries = await Promise.all(STAT_STATUSES.map(async (s) => [s, await count(q => q.eq('status', s))]));
  const stats = Object.fromEntries(entries);
  const [opened, clicked] = await Promise.all([
    count(q => q.not('opened_at', 'is', null)),
    count(q => q.not('clicked_at', 'is', null))
  ]);
  stats.total = entries.reduce((sum, [, n]) => sum + n, 0);
  // Everything Resend has taken, including messages later delivered or bounced
  stats.accepted_total = stats.accepted + stats.delayed + stats.delivered + stats.bounced + stats.complained;
  stats.opened = opened;
  stats.clicked = clicked;
  return stats;
}

async function refreshStats(campaignId) {
  const stats = await computeStats(campaignId);
  await supabase.from('email_campaigns').update({ stats, updated_at: now() }).eq('id', campaignId);
  return stats;
}

/** Who a newsletter would reach right now: confirmed subscribers, minus any suppression. */
async function eligibleSubscribers(audience = {}) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('email_subscribers').select('id, email, first_name').eq('status', 'active').eq('consent_status', 'confirmed')
      .order('created_at', { ascending: true }).range(from, from + PAGE - 1);
    if (Array.isArray(audience.sources) && audience.sources.length) q = q.in('signup_source', audience.sources);
    if (audience.confirmedAfter) q = q.gte('confirmed_at', audience.confirmedAfter);
    const { data, error } = await q;
    if (error) throw new Error('Could not read subscribers');
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const suppressed = new Set();
  for (let i = 0; i < rows.length; i += PAGE) {
    const { data, error } = await supabase.from('email_suppressions').select('email').in('email', rows.slice(i, i + PAGE).map(r => r.email));
    if (error) throw new Error('Could not read suppressions');
    (data || []).forEach(s => suppressed.add(s.email));
  }
  return rows.filter(r => !suppressed.has(r.email));
}

async function buildRecipients(campaign) {
  let rows;
  if (campaign.mode === 'individual') {
    rows = (campaign.audience.emails || []).map(email => ({ email, id: null, first_name: null }));
  } else {
    rows = await eligibleSubscribers(campaign.audience);
  }
  for (let i = 0; i < rows.length; i += PAGE) {
    const chunk = rows.slice(i, i + PAGE).map(r => ({ campaign_id: campaign.id, subscriber_id: r.id, email: r.email, first_name: r.first_name, status: 'pending' }));
    const { error } = await supabase.from('email_campaign_recipients').upsert(chunk, { onConflict: 'campaign_id,email', ignoreDuplicates: true });
    if (error) throw new Error('Could not queue recipients');
  }
  await supabase.from('email_campaigns').update({ recipients_built: true, recipient_count: rows.length, updated_at: now() }).eq('id', campaign.id);
  campaign.recipients_built = true;
  campaign.recipient_count = rows.length;
}

function messageFor(campaign, recipient, settings) {
  const unsub = unsubscribeUrl(recipient.email);
  const { html, text } = buildMessage({
    subject: campaign.subject,
    preheader: campaign.preheader,
    bodyHtml: campaign.body_html,
    settings,
    firstName: recipient.first_name,
    unsubscribeUrl: unsub,
    footerNote: campaign.mode === 'newsletter'
      ? 'You are receiving this because you confirmed your subscription to updates from SHEREBOY TECH LTD.'
      : 'This message was sent to you directly by SHEREBOY TECH LTD.'
  });
  const replyTo = replyToHeader(settings, campaign.reply_to);
  return {
    from: fromHeader(settings),
    to: [recipient.email],
    subject: campaign.subject,
    html,
    text,
    ...(replyTo ? { replyTo } : {}),
    headers: unsubscribeHeaders(recipient.email),
    tags: [{ name: 'campaign_id', value: campaign.id }, { name: 'kind', value: campaign.mode }]
  };
}

/** The last check before sending: nobody is mailed after opting out, even mid-campaign. */
async function filterStillAllowed(campaign, recipients) {
  const emails = recipients.map(r => r.email);
  const { data: suppressed } = await supabase.from('email_suppressions').select('email, reason').in('email', emails);
  const blocked = new Map((suppressed || []).map(s => [s.email, s.reason]));
  if (campaign.mode === 'newsletter') {
    const { data: subs } = await supabase.from('email_subscribers').select('email, status').in('email', emails);
    const active = new Set((subs || []).filter(s => s.status === 'active').map(s => s.email));
    recipients.forEach(r => { if (!active.has(r.email) && !blocked.has(r.email)) blocked.set(r.email, 'not an active subscriber'); });
  }
  for (const [email, reason] of blocked) {
    await supabase.from('email_campaign_recipients').update({ status: 'skipped', last_error: `Skipped: ${reason}`, batch_key: null, updated_at: now() }).eq('campaign_id', campaign.id).eq('email', email);
  }
  return recipients.filter(r => !blocked.has(r.email));
}

async function markAccepted(recipient, providerId) {
  await supabase.from('email_campaign_recipients').update({ status: 'accepted', provider_id: providerId, accepted_at: now(), last_error: null, updated_at: now() })
    .eq('id', recipient.id).in('status', ['sending', 'pending']);
  if (recipient.subscriber_id) await supabase.from('email_subscribers').update({ last_email_at: now(), last_event: 'accepted' }).eq('id', recipient.subscriber_id);
}

const failRecipients = (ids, message) => supabase.from('email_campaign_recipients').update({ status: 'failed', last_error: String(message).slice(0, 300), updated_at: now() }).in('id', ids);
const releaseRecipients = (ids) => supabase.from('email_campaign_recipients').update({ status: 'pending', batch_key: null, claimed_at: null, updated_at: now() }).in('id', ids);

async function pauseCampaign(campaign, ms, message, bump = true) {
  const retry = bump ? campaign.retry_count + 1 : campaign.retry_count;
  await supabase.from('email_campaigns').update({ next_run_at: later(ms), retry_count: retry, last_error: message, updated_at: now() }).eq('id', campaign.id);
}

/** Sends one group, in the group's fixed order, under its fixed idempotency key. */
async function sendGroup(campaign, recipients, batchKey, settings) {
  const resend = getResend();
  const key = `campaign-${campaign.id}-${batchKey}`;
  const ids = recipients.map(r => r.id);
  const payload = recipients.map(r => messageFor(campaign, r, settings));
  let result;
  try {
    result = await resend.batch.send(payload, { idempotencyKey: key });
  } catch (err) {
    result = { error: { name: 'network', message: err.message } };
  }
  const { data, error } = result;

  if (!error) {
    const list = (data && data.data) || [];
    for (let i = 0; i < recipients.length; i += 1) {
      if (list[i] && list[i].id) await markAccepted(recipients[i], list[i].id);
      else await failRecipients([recipients[i].id], 'Resend did not return an id for this message');
    }
    await supabase.from('email_campaigns').update({ retry_count: 0, last_error: null, updated_at: now() }).eq('id', campaign.id);
    return;
  }

  const kind = classifyError(error);
  const message = error.message || error.name || 'Sending failed';
  if (kind === 'quota') {
    // Nothing was sent: wait, and carry on when the quota allows
    await releaseRecipients(ids);
    await pauseCampaign(campaign, 3600 * 1000, `Resend quota reached (${error.name}). Sending will resume automatically.`, false);
  } else if (kind === 'rate') {
    await pauseCampaign(campaign, backoffMs(campaign.retry_count), `Waiting: ${message}`);
    await releaseRecipients(ids);
  } else if (kind === 'account') {
    // A bad key or unverified domain won't fix itself. Stop, and let an administrator resume.
    await releaseRecipients(ids);
    await supabase.from('email_campaigns').update({ status: 'failed', last_error: message, updated_at: now() }).eq('id', campaign.id);
    errorLog.record('email', `Campaign stopped: ${message}`);
  } else if (kind === 'permanent') {
    if (recipients.length > 1) {
      // One bad address can reject a whole batch: try each on its own
      for (const r of recipients) await sendGroup(campaign, [r], `${batchKey}-${r.id}`, settings);
    } else {
      await failRecipients(ids, message);
    }
  } else {
    // Unknown outcome. Keep the claim: the retry reuses the key, so it can't double-send.
    await supabase.from('email_campaign_recipients').update({ claimed_at: new Date(Date.now() - STALE_CLAIM_MS - 1000).toISOString() }).in('id', ids);
    await pauseCampaign(campaign, backoffMs(campaign.retry_count), `Retrying: ${message}`);
  }
}

/** Claims left behind by a crash or a failed call, resent under their original key. */
async function resumeStaleClaims(campaign, settings) {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data: stale } = await supabase.from('email_campaign_recipients').select('*').eq('campaign_id', campaign.id).eq('status', 'sending').lt('claimed_at', cutoff).order('id', { ascending: true }).limit(100);
  if (!stale || !stale.length) return false;
  const batchKey = stale[0].batch_key;
  const { data: group } = await supabase.from('email_campaign_recipients').select('*').eq('campaign_id', campaign.id).eq('batch_key', batchKey).eq('status', 'sending').order('id', { ascending: true });
  const claimedAt = Date.parse(group[0].claimed_at);
  const ids = group.map(r => r.id);
  if (Date.now() - claimedAt > IDEMPOTENCY_WINDOW_MS || group[0].attempts >= MAX_ATTEMPTS) {
    await failRecipients(ids, 'Could not confirm this message was accepted. Not resent, to avoid a duplicate.');
    return true;
  }
  await supabase.from('email_campaign_recipients').update({ attempts: group[0].attempts + 1 }).in('id', ids);
  group.forEach(r => { r.attempts += 1; });
  await sendGroup(campaign, group, batchKey, settings);
  return true;
}

async function finishIfDone(campaign) {
  const open = async (status) => (await supabase.from('email_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('status', status)).count || 0;
  const [pending, sending] = await Promise.all([open('pending'), open('sending')]);
  const stats = await refreshStats(campaign.id);
  if (pending || sending) return;
  const allFailed = stats.total > 0 && stats.failed === stats.total;
  await supabase.from('email_campaigns').update({
    status: allFailed ? 'failed' : 'completed',
    completed_at: now(),
    next_run_at: null,
    ...(allFailed ? { last_error: 'Every message failed.' } : { last_error: null }),
    updated_at: now()
  }).eq('id', campaign.id).eq('status', 'sending');
}

/** One unit of work for one campaign. */
async function processCampaign(campaign) {
  const settings = await getSettings();
  if (!getResend() || !fromHeader(settings)) {
    const message = 'Email sending is not configured: set RESEND_API_KEY and RESEND_FROM_EMAIL.';
    await supabase.from('email_campaigns').update({ status: 'failed', last_error: message, updated_at: now() }).eq('id', campaign.id);
    return;
  }
  if (campaign.status === 'queued') {
    const { data } = await supabase.from('email_campaigns').update({ status: 'sending', started_at: campaign.started_at || now(), updated_at: now() })
      .eq('id', campaign.id).eq('status', 'queued').select('id');
    if (!data || !data.length) return;
    campaign.status = 'sending';
  }
  if (!campaign.recipients_built) await buildRecipients(campaign);

  if (await resumeStaleClaims(campaign, settings)) { await finishIfDone(campaign); return; }

  const { data: pending } = await supabase.from('email_campaign_recipients').select('*').eq('campaign_id', campaign.id).eq('status', 'pending')
    .order('id', { ascending: true }).limit(mailEnv().batchSize);
  if (!pending || !pending.length) { await finishIfDone(campaign); return; }

  const allowed = await filterStillAllowed(campaign, pending);
  if (!allowed.length) { await finishIfDone(campaign); return; }

  // Claim before sending, so a crash after this point can only resend under this key
  const batchKey = crypto.randomUUID();
  const { data: claimed } = await supabase.from('email_campaign_recipients')
    .update({ status: 'sending', batch_key: batchKey, claimed_at: now(), attempts: 1, updated_at: now() })
    .in('id', allowed.map(r => r.id)).eq('status', 'pending').select('*');
  if (!claimed || !claimed.length) return;
  claimed.sort((a, b) => (a.id < b.id ? -1 : 1));
  await sendGroup(campaign, claimed, batchKey, settings);
  await finishIfDone(campaign);
}

// Contact sync is optional and must never crowd out sending. It runs at most once a
// minute, and backs off for longer when Resend refuses it (a send-only API key can't
// manage contacts, and emails still go out without it).
let nextSyncAt = 0;
async function syncPendingContacts() {
  if (Date.now() < nextSyncAt) return;
  nextSyncAt = Date.now() + 60 * 1000;
  const { data: unsynced } = await supabase.from('email_subscribers').select('*').eq('resend_sync_needed', true).limit(5);
  for (const s of unsynced || []) {
    if (!await syncContact(s)) { nextSyncAt = Date.now() + 15 * 60 * 1000; return; }
  }
}

let running = false;
let timer = null;
let warnedMissing = false;

async function tick() {
  if (running) return 0;
  running = true;
  try {
    // Scheduled campaigns that are due become queued
    const { data: due, error } = await supabase.from('email_campaigns').update({ status: 'queued', queued_at: now(), updated_at: now() })
      .eq('status', 'scheduled').lte('scheduled_at', now()).select('id');
    if (error) {
      if (isMissingTableError(error)) { warnedMissing = true; return 0; } // migration not run yet
      throw new Error(error.message);
    }
    if (due && due.length) console.log(`[email] ${due.length} scheduled campaign(s) queued`);

    const { data: campaigns } = await supabase.from('email_campaigns').select('*').in('status', ['queued', 'sending'])
      .order('created_at', { ascending: true }).limit(20);
    const ready = (campaigns || []).filter(c => !c.next_run_at || Date.parse(c.next_run_at) <= Date.now());
    if (ready[0]) await processCampaign(ready[0]);

    await syncPendingContacts();
    return ready.length;
  } catch (err) {
    errorLog.record('email', `Campaign worker: ${err.message}`);
    console.error('[email] worker error:', err.message);
    return 0;
  } finally {
    running = false;
  }
}

function startWorker() {
  if (timer) return;
  timer = setInterval(tick, mailEnv().tickMs);
  timer.unref();
}

module.exports = { startWorker, tick, computeStats, refreshStats, eligibleSubscribers, messageFor, backoffMs, wasMigrationMissing: () => warnedMissing };
