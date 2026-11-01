// server/routes/emailMarketing.js
// The admin Email Marketing center. Administrators only, enforced here. Editors
// and anonymous visitors can't read subscribers or send anything.
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth, requireRole } = require('../auth');
const { logActivity } = require('../activityLog');
const { rateLimit, sanitizeString, sanitizeUrl } = require('../middleware/security');
const { isMissingTableError } = require('../dbCompat');
const { mailEnv, getSettings, forgetSettings, fromHeader, replyToHeader, configStatus, sendingDomain, domainOf } = require('../mail/config');
const { getResend } = require('../mail/resendClient');
const { buildMessage, sanitizeEmailHtml, DEFAULT_TEMPLATES } = require('../mail/render');
const { normalizeEmail, suppress, unsubscribe, recordEvent } = require('../mail/subscribers');
const { unsubscribeUrl } = require('../mail/tokens');
const { computeStats, eligibleSubscribers, tick } = require('../mail/worker');
const errorLog = require('../errorLog');

const MIGRATION = { error: 'Email marketing needs the latest database update. Run database/migrations/2026-11-02-email-marketing.sql.', code: 'MIGRATION_REQUIRED' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBSCRIBER_STATUSES = ['pending', 'active', 'unsubscribed', 'bounced', 'complained', 'suppressed'];
const nowIso = () => new Date().toISOString();

router.use(requireAuth, requireRole('admin'));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.param('id', (req, res, next, id) => (UUID_RE.test(id) ? next() : res.status(404).json({ error: 'Not found.' })));

const dbFail = (res, error, message) => {
  if (isMissingTableError(error)) return res.status(409).json(MIGRATION);
  errorLog.record('email', message);
  return res.status(500).json({ error: message });
};

const headCount = async (table, filter = (q) => q) => {
  const { count, error } = await filter(supabase.from(table).select('id', { count: 'exact', head: true }));
  if (error) throw error;
  return count || 0;
};
const headCountNoId = async (table, filter = (q) => q) => {
  const { count, error } = await filter(supabase.from(table).select('email', { count: 'exact', head: true }));
  if (error) throw error;
  return count || 0;
};

// ---------- Overview ----------
router.get('/overview', async (req, res) => {
  try {
    const sub = (status) => headCount('email_subscribers', q => q.eq('status', status));
    const rec = (status) => headCount('email_campaign_recipients', q => q.eq('status', status));
    const [total, active, pending, unsubscribed, bounced, complained, suppressions, campaignsSent, scheduled, delivered, accepted, delayed, bouncedMsgs, complaints, failed] = await Promise.all([
      headCount('email_subscribers'), sub('active'), sub('pending'), sub('unsubscribed'), sub('bounced'), sub('complained'),
      headCountNoId('email_suppressions'),
      headCount('email_campaigns', q => q.in('status', ['completed', 'sending'])),
      headCount('email_campaigns', q => q.eq('status', 'scheduled')),
      rec('delivered'), rec('accepted'), rec('delayed'), rec('bounced'), rec('complained'), rec('failed')
    ]);
    const settings = await getSettings();
    res.json({
      subscribers: { total, active, pending, unsubscribed, bounced, complained, suppressions },
      campaigns: { sent: campaignsSent, scheduled },
      messages: { delivered, awaitingConfirmation: accepted + delayed, bounced: bouncedMsgs, complaints, failed },
      config: configStatus(settings)
    });
  } catch (error) { dbFail(res, error, 'Failed to load the email overview.'); }
});

// ---------- Subscribers ----------
function subscriberQuery(q, { status, source, search }) {
  let query = q;
  if (SUBSCRIBER_STATUSES.includes(status)) query = query.eq('status', status);
  if (source) query = query.eq('signup_source', String(source).slice(0, 40));
  if (search) query = query.ilike('email', `%${String(search).replace(/[%,()*\\]/g, '').slice(0, 120)}%`);
  return query;
}
const SUBSCRIBER_LIST = 'id, email, first_name, status, consent_status, signup_source, confirmed_at, unsubscribed_at, last_email_at, last_event, created_at';

router.get('/subscribers', async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
  const { data, error, count } = await subscriberQuery(supabase.from('email_subscribers').select(SUBSCRIBER_LIST, { count: 'exact' }), req.query)
    .order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  if (error) return dbFail(res, error, 'Failed to load subscribers.');
  res.json({ subscribers: data || [], total: count || 0, page, limit });
});

router.get('/subscribers/export.csv', async (req, res) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await subscriberQuery(supabase.from('email_subscribers').select('email, first_name, status, consent_status, consent_timestamp, signup_source, confirmed_at, unsubscribed_at, created_at'), req.query)
      .order('created_at', { ascending: false }).range(from, from + 999);
    if (error) return dbFail(res, error, 'Failed to export subscribers.');
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  // A value starting with = + - @ would run as a formula in a spreadsheet app
  const cell = (v) => `"${String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
  const head = ['email', 'first_name', 'status', 'consent_status', 'consent_timestamp', 'signup_source', 'confirmed_at', 'unsubscribed_at', 'created_at'];
  const csv = [head.join(','), ...rows.map(r => head.map(k => cell(r[k])).join(','))].join('\n');
  logActivity(req.session.user, 'email_subscribers_exported', `Exported ${rows.length} subscriber record(s)`);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="subscribers.csv"');
  res.send(csv);
});

router.get('/subscribers/:id', async (req, res) => {
  const { data, error } = await supabase.from('email_subscribers').select('id, email, first_name, status, consent_status, consent_timestamp, consent_text, signup_source, confirmed_at, unsubscribed_at, unsubscribe_source, last_email_at, last_event, created_at, updated_at').eq('id', req.params.id).maybeSingle();
  if (error) return dbFail(res, error, 'Failed to load the subscriber.');
  if (!data) return res.status(404).json({ error: 'Subscriber not found.' });
  const [events, suppression] = await Promise.all([
    supabase.from('email_events').select('type, detail, occurred_at').eq('email', data.email).order('occurred_at', { ascending: false }).limit(20),
    supabase.from('email_suppressions').select('reason, source, created_at').eq('email', data.email).maybeSingle()
  ]);
  res.json({ subscriber: data, events: events.data || [], suppression: suppression.data || null });
});

// POST /subscribers/:id/unsubscribe — on the person's behalf. There is deliberately
// no route that resubscribes anyone: only their own confirmed request can do that.
router.post('/subscribers/:id/unsubscribe', async (req, res) => {
  const { data: s, error } = await supabase.from('email_subscribers').select('email').eq('id', req.params.id).maybeSingle();
  if (error) return dbFail(res, error, 'Failed to update the subscriber.');
  if (!s) return res.status(404).json({ error: 'Subscriber not found.' });
  await unsubscribe(s.email, `admin: ${req.session.user.username}`);
  logActivity(req.session.user, 'email_subscriber_unsubscribed', `Unsubscribed ${s.email} on their behalf`);
  res.json({ success: true });
});

router.post('/subscribers/:id/suppress', async (req, res) => {
  const { data: s, error } = await supabase.from('email_subscribers').select('email').eq('id', req.params.id).maybeSingle();
  if (error) return dbFail(res, error, 'Failed to update the subscriber.');
  if (!s) return res.status(404).json({ error: 'Subscriber not found.' });
  await suppress(s.email, 'manual', `admin: ${req.session.user.username}`);
  await supabase.from('email_subscribers').update({ status: 'suppressed', confirmation_token_hash: null, confirmation_expires_at: null, updated_at: nowIso() }).eq('id', req.params.id).in('status', ['active', 'pending']);
  await recordEvent({ type: 'local.suppressed', email: s.email, detail: 'manual' });
  logActivity(req.session.user, 'email_subscriber_suppressed', `Suppressed ${s.email}`);
  res.json({ success: true });
});

// DELETE removes the person's record. The address stays on the never-mail list.
router.delete('/subscribers/:id', async (req, res) => {
  const { data: s, error } = await supabase.from('email_subscribers').select('email').eq('id', req.params.id).maybeSingle();
  if (error) return dbFail(res, error, 'Failed to remove the subscriber.');
  if (!s) return res.status(404).json({ error: 'Subscriber not found.' });
  await suppress(s.email, 'manual', `removed by ${req.session.user.username}`);
  const del = await supabase.from('email_subscribers').delete().eq('id', req.params.id);
  if (del.error) return dbFail(res, del.error, 'Failed to remove the subscriber.');
  logActivity(req.session.user, 'email_subscriber_removed', `Removed ${s.email}; address stays suppressed`);
  res.json({ success: true });
});

router.get('/segments', async (req, res) => {
  const { data, error } = await supabase.from('email_subscribers').select('signup_source').eq('status', 'active').limit(1000);
  if (error) return dbFail(res, error, 'Failed to load segments.');
  const counts = {};
  (data || []).forEach(r => { const k = r.signup_source || 'other'; counts[k] = (counts[k] || 0) + 1; });
  res.json({ sources: Object.entries(counts).map(([source, count]) => ({ source, count })) });
});

// ---------- Templates ----------
router.get('/templates', async (req, res) => {
  const first = await supabase.from('email_templates').select('*').order('created_at', { ascending: true });
  if (first.error) return dbFail(res, first.error, 'Failed to load templates.');
  if (first.data.length) return res.json({ templates: first.data });
  const seeded = await supabase.from('email_templates').insert(DEFAULT_TEMPLATES).select('*');
  if (seeded.error) return dbFail(res, seeded.error, 'Failed to create the starter templates.');
  res.json({ templates: seeded.data });
});

function templatePayload(b) {
  return {
    name: sanitizeString(b.name, 150),
    category: sanitizeString(b.category, 60) || null,
    subject: sanitizeString(b.subject, 200),
    preheader: sanitizeString(b.preheader, 200) || null,
    body_html: sanitizeEmailHtml(b.body_html),
    updated_at: nowIso()
  };
}

router.post('/templates', async (req, res) => {
  const payload = templatePayload(req.body || {});
  if (!payload.name) return res.status(400).json({ error: 'Give the template a name.' });
  const { data, error } = await supabase.from('email_templates').insert(payload).select('*').single();
  if (error) return dbFail(res, error, 'Failed to save the template.');
  logActivity(req.session.user, 'email_template_created', `Created template "${payload.name}"`);
  res.status(201).json({ template: data });
});

router.put('/templates/:id', async (req, res) => {
  const payload = templatePayload(req.body || {});
  if (!payload.name) return res.status(400).json({ error: 'Give the template a name.' });
  const { data, error } = await supabase.from('email_templates').update(payload).eq('id', req.params.id).select('*').maybeSingle();
  if (error) return dbFail(res, error, 'Failed to save the template.');
  if (!data) return res.status(404).json({ error: 'Template not found.' });
  logActivity(req.session.user, 'email_template_edited', `Edited template "${payload.name}"`);
  res.json({ template: data });
});

router.delete('/templates/:id', async (req, res) => {
  const { error } = await supabase.from('email_templates').delete().eq('id', req.params.id);
  if (error) return dbFail(res, error, 'Failed to delete the template.');
  logActivity(req.session.user, 'email_template_deleted', 'Deleted a template');
  res.json({ success: true });
});

// ---------- Campaigns ----------
function parseIndividualRecipients(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const seen = new Set(); const emails = []; const invalid = [];
  list.map(s => String(s).trim()).filter(Boolean).forEach((raw) => {
    const email = normalizeEmail(raw);
    if (!email) invalid.push(raw.slice(0, 80));
    else if (!seen.has(email)) { seen.add(email); emails.push(email); }
  });
  return { emails, invalid };
}

function campaignPayload(b, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) out.name = sanitizeString(b.name, 150);
  if (has('subject')) out.subject = sanitizeString(b.subject, 200);
  if (has('preheader')) out.preheader = sanitizeString(b.preheader, 200) || null;
  if (has('body_html')) out.body_html = sanitizeEmailHtml(b.body_html);
  if (has('mode')) out.mode = b.mode === 'individual' ? 'individual' : 'newsletter';
  if (has('reply_to')) {
    const replyTo = b.reply_to ? normalizeEmail(b.reply_to) : null;
    if (b.reply_to && !replyTo) { const e = new Error('The reply-to address is not valid.'); e.status = 400; throw e; }
    out.reply_to = replyTo;
  }
  if (has('audience')) {
    const a = b.audience || {};
    const sources = Array.isArray(a.sources) ? a.sources.map(s => sanitizeString(String(s), 40)).filter(Boolean).slice(0, 20) : [];
    const confirmedAfter = Date.parse(a.confirmedAfter) ? new Date(a.confirmedAfter).toISOString() : null;
    const { emails } = parseIndividualRecipients(a.emails);
    out.audience = { sources, confirmedAfter, emails };
  }
  out.updated_at = nowIso();
  return out;
}

const withErrors = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (isMissingTableError(err)) return res.status(409).json(MIGRATION);
    errorLog.record('email', err.message, { method: req.method, path: req.route && req.route.path });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

router.get('/campaigns', async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  let q = supabase.from('email_campaigns').select('id, name, mode, subject, audience, status, scheduled_at, queued_at, started_at, completed_at, recipient_count, stats, last_error, created_by, created_at, updated_at', { count: 'exact' })
    .order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  if (req.query.status) q = q.eq('status', String(req.query.status).slice(0, 20));
  const { data, error, count } = await q;
  if (error) return dbFail(res, error, 'Failed to load campaigns.');
  res.json({ campaigns: data || [], total: count || 0, page, limit });
});

router.post('/campaigns', withErrors(async (req, res) => {
  const payload = campaignPayload(req.body || {});
  if (!payload.name) payload.name = payload.subject || 'Untitled campaign';
  const { data, error } = await supabase.from('email_campaigns').insert({ ...payload, status: 'draft', created_by: req.session.user.username }).select('*').single();
  if (error) throw error;
  logActivity(req.session.user, 'email_campaign_created', `Created draft "${data.name}"`);
  res.status(201).json({ campaign: data });
}));

const loadCampaign = async (id) => {
  const { data, error } = await supabase.from('email_campaigns').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) { const e = new Error('Campaign not found.'); e.status = 404; throw e; }
  return data;
};

router.get('/campaigns/:id', withErrors(async (req, res) => {
  const campaign = await loadCampaign(req.params.id);
  const stats = await computeStats(campaign.id);
  const { data: failures } = await supabase.from('email_campaign_recipients').select('email, status, last_error, updated_at')
    .eq('campaign_id', campaign.id).in('status', ['failed', 'bounced', 'complained', 'skipped']).order('updated_at', { ascending: false }).limit(50);
  res.json({ campaign, stats, problems: failures || [] });
}));

router.put('/campaigns/:id', withErrors(async (req, res) => {
  const payload = campaignPayload(req.body || {}, { partial: true });
  // Only drafts can change: what was sent stays a true record of what was sent
  const { data, error } = await supabase.from('email_campaigns').update(payload).eq('id', req.params.id).eq('status', 'draft').select('*');
  if (error) throw error;
  if (!data || !data.length) return res.status(409).json({ error: 'Only a draft can be edited.' });
  res.json({ campaign: data[0] });
}));

router.delete('/campaigns/:id', withErrors(async (req, res) => {
  const { data, error } = await supabase.from('email_campaigns').delete().eq('id', req.params.id).eq('status', 'draft').select('id, name');
  if (error) throw error;
  if (!data || !data.length) return res.status(409).json({ error: 'Only a draft can be deleted.' });
  logActivity(req.session.user, 'email_campaign_deleted', `Deleted draft "${data[0].name}"`);
  res.json({ success: true });
}));

// Copying is the way to re-send: a new draft, with new confirmation checks
router.post('/campaigns/:id/duplicate', withErrors(async (req, res) => {
  const c = await loadCampaign(req.params.id);
  const { data, error } = await supabase.from('email_campaigns').insert({
    name: `${c.name} (copy)`.slice(0, 150), mode: c.mode, subject: c.subject, preheader: c.preheader, body_html: c.body_html, reply_to: c.reply_to, audience: c.audience, status: 'draft', created_by: req.session.user.username
  }).select('*').single();
  if (error) throw error;
  res.status(201).json({ campaign: data });
}));

async function audienceFor(campaign) {
  if (campaign.mode === 'individual') {
    const emails = campaign.audience.emails || [];
    if (!emails.length) return { count: 0, blocked: [] };
    const { data } = await supabase.from('email_suppressions').select('email').in('email', emails);
    const blocked = (data || []).map(s => s.email);
    return { count: emails.length - blocked.length, blocked };
  }
  const rows = await eligibleSubscribers(campaign.audience);
  return { count: rows.length, blocked: [] };
}

router.get('/campaigns/:id/estimate', withErrors(async (req, res) => {
  const campaign = await loadCampaign(req.params.id);
  const { count, blocked } = await audienceFor(campaign);
  res.json({ count, blocked, largeAudienceThreshold: mailEnv().largeAudience, confirmRequired: count >= mailEnv().largeAudience });
}));

function requireSendable(campaign) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (!campaign.subject) bad('Add a subject before sending.');
  if (!sanitizeEmailHtml(campaign.body_html)) bad('Write the email before sending.');
}

/** Everything that must be true before a campaign may leave the draft state. */
async function checkBeforeQueue(req, campaign) {
  const body = req.body || {};
  const env = mailEnv();
  const stop = (m, status = 400, code) => { const e = new Error(m); e.status = status; e.code = code; throw e; };
  requireSendable(campaign);
  const settings = await getSettings();
  if (!getResend() || !fromHeader(settings)) stop('Email sending is not configured: set RESEND_API_KEY and RESEND_FROM_EMAIL on the server.');

  const { count, blocked } = await audienceFor(campaign);
  if (!count) stop(campaign.mode === 'individual' ? 'None of these addresses can be emailed. They may have unsubscribed.' : 'No confirmed subscribers match this audience.');

  if (campaign.mode === 'individual') {
    if (body.acknowledged !== true) stop('Confirm that these people expect this message from us.');
    if (count > env.individualMax) stop(`Individual emails can go to at most ${env.individualMax} people. For more, use a newsletter campaign to confirmed subscribers.`);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: recent } = await supabase.from('email_campaigns').select('recipient_count').eq('mode', 'individual').gte('queued_at', since).neq('status', 'cancelled');
    const used = (recent || []).reduce((n, c) => n + (c.recipient_count || 0), 0);
    if (used + count > env.individualDaily) stop(`The limit of ${env.individualDaily} individual emails per 24 hours would be exceeded (${used} already used).`);
  }
  // The typed count proves someone looked at the size of this audience
  if (count >= env.largeAudience && Number(body.confirmCount) !== count) stop(`This will email ${count} people. Confirm the exact number to continue.`, 409);

  // The same message just went out? That is usually a mistake.
  if (body.allowRepeat !== true) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: similar } = await supabase.from('email_campaigns').select('id, name').eq('subject', campaign.subject).neq('id', campaign.id).in('status', ['queued', 'sending', 'completed', 'scheduled']).gte('created_at', since).limit(1);
    if (similar && similar.length) stop(`A campaign with this subject ("${similar[0].name}") went out in the last 24 hours. Confirm if you really want to send it again.`, 409, 'POSSIBLE_DUPLICATE');
  }
  return { count, blocked };
}

// POST /campaigns/:id/send — only the first request can move it out of draft
router.post('/campaigns/:id/send', withErrors(async (req, res) => {
  const campaign = await loadCampaign(req.params.id);
  if (campaign.status !== 'draft') return res.status(409).json({ error: `This campaign is already ${campaign.status}.` });
  let check;
  try { check = await checkBeforeQueue(req, campaign); } catch (err) {
    if (err.code) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
  const { data, error } = await supabase.from('email_campaigns')
    .update({
      status: 'queued', queued_at: nowIso(), recipient_count: check.count, last_error: null, updated_at: nowIso(),
      ...(campaign.mode === 'individual' ? { acknowledged_by: req.session.user.username, audience: { ...campaign.audience, emails: (campaign.audience.emails || []).filter(e => !check.blocked.includes(e)) } } : {})
    })
    .eq('id', campaign.id).eq('status', 'draft').select('id');
  if (error) throw error;
  if (!data || !data.length) return res.status(409).json({ error: 'This campaign has already been sent.' });
  logActivity(req.session.user, 'email_campaign_sent', `Queued "${campaign.name}" (${campaign.mode}) to ${check.count} recipient(s)`);
  tick().catch(() => {});
  res.status(202).json({ queued: true, recipients: check.count, skipped: check.blocked.length });
}));

router.post('/campaigns/:id/schedule', withErrors(async (req, res) => {
  const campaign = await loadCampaign(req.params.id);
  if (campaign.status !== 'draft') return res.status(409).json({ error: `This campaign is already ${campaign.status}.` });
  const when = Date.parse((req.body || {}).scheduled_at);
  if (!when || when < Date.now() + 60000) return res.status(400).json({ error: 'Choose a time in the future.' });
  let check;
  try { check = await checkBeforeQueue(req, campaign); } catch (err) {
    if (err.code) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
  const { data, error } = await supabase.from('email_campaigns')
    .update({ status: 'scheduled', scheduled_at: new Date(when).toISOString(), recipient_count: check.count, updated_at: nowIso() })
    .eq('id', campaign.id).eq('status', 'draft').select('id');
  if (error) throw error;
  if (!data || !data.length) return res.status(409).json({ error: 'This campaign has already been sent.' });
  logActivity(req.session.user, 'email_campaign_scheduled', `Scheduled "${campaign.name}" for ${new Date(when).toISOString()}`);
  res.json({ scheduled: true });
}));

router.post('/campaigns/:id/cancel', withErrors(async (req, res) => {
  const { data, error } = await supabase.from('email_campaigns').update({ status: 'cancelled', next_run_at: null, updated_at: nowIso() })
    .eq('id', req.params.id).in('status', ['scheduled', 'queued', 'sending']).select('id, name');
  if (error) throw error;
  if (!data || !data.length) return res.status(409).json({ error: 'This campaign can no longer be cancelled.' });
  logActivity(req.session.user, 'email_campaign_cancelled', `Cancelled "${data[0].name}"`);
  res.json({ cancelled: true });
}));

// Picks up where a failed campaign stopped. Anyone already sent to is not sent to again.
router.post('/campaigns/:id/resume', withErrors(async (req, res) => {
  const { data, error } = await supabase.from('email_campaigns').update({ status: 'sending', next_run_at: null, retry_count: 0, last_error: null, updated_at: nowIso() })
    .eq('id', req.params.id).eq('status', 'failed').select('id, name');
  if (error) throw error;
  if (!data || !data.length) return res.status(409).json({ error: 'Only a failed campaign can be resumed.' });
  logActivity(req.session.user, 'email_campaign_resumed', `Resumed "${data[0].name}"`);
  tick().catch(() => {});
  res.json({ resumed: true });
}));

// ---------- Preview and test ----------
router.post('/preview', withErrors(async (req, res) => {
  const b = req.body || {};
  const settings = await getSettings();
  const subject = sanitizeString(b.subject, 200) || '(no subject)';
  const { html, text } = buildMessage({
    subject, preheader: sanitizeString(b.preheader, 200), bodyHtml: b.body_html, settings, firstName: 'Ada',
    unsubscribeUrl: `${mailEnv().baseUrl}/newsletter/unsubscribe`,
    footerNote: b.mode === 'individual' ? 'This message was sent to you directly by SHEREBOY TECH LTD.' : 'You are receiving this because you confirmed your subscription to updates from SHEREBOY TECH LTD.'
  });
  res.json({ html, text, sanitizedBody: sanitizeEmailHtml(b.body_html) });
}));

const testLimiter = rateLimit({ windowMs: 3600 * 1000, max: () => mailEnv().testHourly, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many test emails this hour.' } });

router.post('/test', testLimiter, withErrors(async (req, res) => {
  const b = req.body || {};
  const { emails, invalid } = parseIndividualRecipients(b.to);
  if (invalid.length || !emails.length || emails.length > 3) return res.status(400).json({ error: 'Enter one to three valid test addresses.' });
  const settings = await getSettings();
  const resend = getResend();
  const from = fromHeader(settings);
  if (!resend || !from) return res.status(400).json({ error: 'Email sending is not configured: set RESEND_API_KEY and RESEND_FROM_EMAIL on the server.' });
  const { data: blocked } = await supabase.from('email_suppressions').select('email').in('email', emails);
  if (blocked && blocked.length) return res.status(400).json({ error: `${blocked[0].email} has opted out or can't receive email.` });
  const subject = `[TEST] ${sanitizeString(b.subject, 190) || '(no subject)'}`;
  const replyTo = replyToHeader(settings, b.reply_to ? normalizeEmail(b.reply_to) : null);
  const results = [];
  for (const email of emails) {
    const { html, text } = buildMessage({ subject, preheader: sanitizeString(b.preheader, 200), bodyHtml: b.body_html, settings, unsubscribeUrl: unsubscribeUrl(email), footerNote: 'This is a test message sent from the SHEREBOY TECH LTD email center.' });
    const { data, error } = await resend.emails.send({ from, to: [email], subject, html, text, ...(replyTo ? { replyTo } : {}), tags: [{ name: 'kind', value: 'test' }] });
    if (error) return res.status(502).json({ error: `Resend did not accept the message: ${error.message}` });
    results.push({ email, id: data && data.id });
  }
  logActivity(req.session.user, 'email_test_sent', `Sent a test email to ${emails.join(', ')}`);
  res.json({ accepted: results.length, note: 'Resend accepted the message. That does not yet prove it was delivered.' });
}));

// ---------- Settings ----------
router.get('/settings', withErrors(async (req, res) => {
  const settings = await getSettings({ fresh: true });
  res.json({ settings, config: configStatus(settings) });
}));

router.put('/settings', withErrors(async (req, res) => {
  const b = req.body || {};
  const text = (k, n) => sanitizeString(b[k], n);
  const bad = (m) => res.status(400).json({ error: m });
  const senderEmail = b.sender_email ? normalizeEmail(b.sender_email) : '';
  if (b.sender_email && !senderEmail) return bad('The sender address is not valid.');
  if (senderEmail && domainOf(senderEmail) !== sendingDomain()) return bad(`The sender must use your verified domain (${sendingDomain()}).`);
  const replyTo = b.reply_to ? normalizeEmail(b.reply_to) : '';
  if (b.reply_to && !replyTo) return bad('The reply-to address is not valid.');
  const contactEmail = b.contact_email ? normalizeEmail(b.contact_email) : '';
  if (b.contact_email && !contactEmail) return bad('The contact email is not valid.');
  const logo = sanitizeUrl(b.logo_url, 1000);
  if (b.logo_url && !/^https:\/\//.test(logo)) return bad('The logo must be a full https:// address so email apps can load it.');
  const hours = parseInt(b.confirmation_expiry_hours, 10);
  if (b.confirmation_expiry_hours !== undefined && !(hours >= 1 && hours <= 168)) return bad('Confirmation links can last from 1 to 168 hours.');
  const payload = {
    id: 1,
    sender_name: text('sender_name', 100), sender_email: senderEmail, reply_to: replyTo,
    newsletter_description: text('newsletter_description', 500),
    confirmation_subject: text('confirmation_subject', 200), confirmation_intro: text('confirmation_intro', 800),
    confirmation_expiry_hours: Number.isNaN(hours) ? 48 : hours,
    welcome_enabled: b.welcome_enabled !== false,
    welcome_subject: text('welcome_subject', 200), welcome_body: sanitizeEmailHtml(b.welcome_body),
    footer_text: text('footer_text', 300), logo_url: logo,
    contact_address: text('contact_address', 300), contact_email: contactEmail, contact_phone: text('contact_phone', 40),
    updated_at: nowIso()
  };
  const { error } = await supabase.from('email_settings').upsert(payload, { onConflict: 'id' });
  if (error) throw error;
  forgetSettings();
  logActivity(req.session.user, 'email_settings_updated', 'Updated email settings');
  const settings = await getSettings({ fresh: true });
  res.json({ settings, config: configStatus(settings) });
}));

module.exports = router;
