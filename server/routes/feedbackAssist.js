// server/routes/feedbackAssist.js
// Customer emails and the AI assistant inside Reviews & Feedback (mounted under
// /api/feedback-admin). Staff write and send; the AI only drafts. Nothing an
// administrator generates is sent until they press Send.
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth, requireRole } = require('../auth');
const { logActivity } = require('../activityLog');
const { rateLimit, sanitizeString } = require('../middleware/security');
const { isMissingTableError } = require('../dbCompat');
const comms = require('../feedbackComms');
const ai = require('../feedbackAi');
const errorLog = require('../errorLog');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_KINDS = ['reply', 'info_request', 'follow_up', 'resolved'];
const OPEN = ['new', 'under_review', 'in_progress', 'responded'];
const nowIso = () => new Date().toISOString();
const byUser = (req) => `u:${req.session && req.session.user ? req.session.user.username : 'anon'}`;

// Limits protect the sending reputation and the AI quota, per staff member
const sendLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, keyGenerator: byUser, standardHeaders: true, legacyHeaders: false, message: { error: 'You have sent many emails in the last hour. Please wait a little.' } });
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 120, keyGenerator: byUser, standardHeaders: true, legacyHeaders: false, message: { error: 'The AI assistant has been used a lot in the last hour. Please wait a little.' } });

router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.param('id', (req, res, next, id) => (UUID_RE.test(id) ? next() : res.status(404).json({ error: 'Not found.' })));
// Every route here needs the 2026-11-09 database update
router.use(async (req, res, next) => ((await comms.commsReady()) ? next() : res.status(409).json(comms.COMMS_MIGRATION)));

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof ai.AiError) return res.status(503).json({ error: err.message });
    if (isMissingTableError(err)) return res.status(409).json(comms.COMMS_MIGRATION);
    if (err.status) return res.status(err.status).json({ error: err.message });
    errorLog.record('feedback', err.message, { method: req.method, path: req.route && req.route.path });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
const must = ({ data, error }) => { if (error) throw error; return data; };
const fail = (status, message) => Object.assign(new Error(message), { status });

const ITEM_COLS = 'id, reference, name, email, rating, category, subject, message, status, source, awaiting_customer, product:products(name)';
async function loadItem(id) {
  const item = must(await supabase.from('feedback').select(ITEM_COLS).eq('id', id).maybeSingle());
  if (!item) throw fail(404, 'Feedback not found.');
  return item;
}
const history = async (id) => must(await supabase.from('feedback_emails').select('direction, kind, subject, body, created_at').eq('feedback_id', id).neq('status', 'discarded').order('created_at', { ascending: true }));
const emailOut = (r) => r && { id: r.id, kind: r.kind, subject: r.subject, body: r.body, status: r.status, error: r.error, attempts: r.attempts, sent_at: r.sent_at, created_at: r.created_at, ai_generated: r.ai_generated, author: r.author };

// ---------- Settings ----------
router.get('/ai/settings', handle(async (req, res) => {
  res.json({ settings: await comms.getAiSettings(), aiConfigured: ai.aiConfigured() });
}));

router.put('/ai/settings', requireRole('admin'), handle(async (req, res) => {
  const b = req.body || {};
  const update = { updated_by: req.session.user.username, updated_at: nowIso() };
  ['auto_reply_enabled', 'require_approval', 'status_emails_enabled'].forEach(k => { if (b[k] !== undefined) update[k] = !!b[k]; });
  const fields = 'auto_reply_enabled, require_approval, status_emails_enabled, updated_by, updated_at';
  // The migration creates the single settings row; recreate it if it was removed
  let data = must(await supabase.from('feedback_ai_settings').update(update).eq('id', 1).select(fields))[0];
  if (!data) data = must(await supabase.from('feedback_ai_settings').insert({ id: 1, ...update }).select(fields).single());
  logActivity(req.session.user, 'feedback_ai_settings', `Automatic AI replies ${data.auto_reply_enabled ? 'on' : 'off'}, approval ${data.require_approval ? 'required' : 'not required'}, status emails ${data.status_emails_enabled ? 'on' : 'off'}`);
  res.json({ settings: data });
}));

// ---------- The AI Assistant overview ----------
router.get('/ai/overview', handle(async (req, res) => {
  const open = must(await supabase.from('feedback').select('id, reference, name, subject, status, rating, category, sentiment, ai_classification, ai_summary, needs_attention, attention_reason, ai_status, awaiting_customer, created_at, product:products(name)').in('status', OPEN).order('created_at', { ascending: false }).limit(500));
  const ids = open.map(r => r.id);
  const [answeredEmails, answeredOld, pending, log, all] = await Promise.all([
    ids.length ? supabase.from('feedback_emails').select('feedback_id').in('feedback_id', ids).in('kind', ['reply', 'info_request', 'follow_up', 'ai_reply', 'resolved']).eq('status', 'sent') : { data: [] },
    ids.length ? supabase.from('feedback_responses').select('feedback_id').in('feedback_id', ids) : { data: [] },
    supabase.from('feedback_emails').select('id, feedback_id, subject, body, created_at, feedback:feedback(reference, name, email)').eq('status', 'pending_approval').order('created_at', { ascending: true }).limit(50),
    supabase.from('feedback_ai_log').select('id, action, actor, outcome, detail, created_at, feedback:feedback(id, reference)').order('created_at', { ascending: false }).limit(30),
    supabase.from('feedback').select('sentiment, ai_classification, ai_status, ai_handled')
  ]);
  const answered = new Set([...(answeredEmails.data || []), ...(answeredOld.data || [])].map(r => r.feedback_id));
  const rows = all.data || [];
  const count = (key, value) => rows.filter(r => r[key] === value).length;
  const brief = (r) => ({ id: r.id, reference: r.reference, name: r.name, subject: r.subject, status: r.status, rating: r.rating, product: r.product ? r.product.name : null, sentiment: r.sentiment, classification: r.ai_classification, summary: r.ai_summary, reason: r.attention_reason, created_at: r.created_at });
  res.json({
    aiConfigured: ai.aiConfigured(),
    settings: await comms.getAiSettings(),
    sentiment: { positive: count('sentiment', 'positive'), neutral: count('sentiment', 'neutral'), negative: count('sentiment', 'negative') },
    classification: ai.CLASSIFICATIONS.map(c => ({ key: c, count: count('ai_classification', c) })),
    analysed: count('ai_status', 'done'),
    analysisFailed: count('ai_status', 'failed'),
    aiHandled: rows.filter(r => r.ai_handled).length,
    needsAttention: open.filter(r => r.needs_attention).map(brief),
    unanswered: open.filter(r => !answered.has(r.id) && !r.awaiting_customer).map(brief),
    awaitingCustomer: open.filter(r => r.awaiting_customer).map(brief),
    pendingApproval: (pending.data || []).map(p => ({ id: p.id, feedback_id: p.feedback_id, subject: p.subject, body: p.body, created_at: p.created_at, reference: p.feedback ? p.feedback.reference : '', name: p.feedback ? p.feedback.name : '', email: p.feedback ? p.feedback.email : '' })),
    activity: (log.data || []).map(l => ({ ...l, reference: l.feedback ? l.feedback.reference : null, feedback_id: l.feedback ? l.feedback.id : null, feedback: undefined }))
  });
}));

// ---------- Per ticket ----------
router.post('/items/:id/analyze', aiLimiter, handle(async (req, res) => {
  const item = await loadItem(req.params.id);
  try {
    const a = await ai.analyzeFeedback(item, item.product && item.product.name);
    const update = { ai_classification: a.classification, sentiment: a.sentiment, ai_summary: a.summary, ai_follow_up_questions: a.follow_up_questions, ai_suggested_reply: a.suggested_reply, needs_attention: a.needs_attention, attention_reason: a.attention_reason, ai_status: 'done', ai_analyzed_at: nowIso() };
    must(await supabase.from('feedback').update(update).eq('id', item.id));
    await comms.aiLog(item.id, 'analyze', req.session.user.username, 'ok', `${a.classification}, ${a.sentiment}`);
    res.json({ analysis: update });
  } catch (err) {
    await supabase.from('feedback').update({ ai_status: 'failed' }).eq('id', item.id);
    await comms.aiLog(item.id, 'analyze', req.session.user.username, 'failed', err.message);
    throw err;
  }
}));

// Drafts only: the administrator edits the text and decides whether to send it
router.post('/items/:id/compose', aiLimiter, handle(async (req, res) => {
  const b = req.body || {};
  const action = ai.ACTIONS.includes(b.action) ? b.action : 'generate';
  const draft = sanitizeString(b.draft, 6000);
  if (['improve', 'shorter', 'professional'].includes(action) && draft.length < 5) throw fail(400, 'Write or generate a message first, then the AI can rework it.');
  const item = await loadItem(req.params.id);
  try {
    const out = await ai.composeMessage({ item, productName: item.product && item.product.name, history: await history(item.id), instruction: sanitizeString(b.instruction, 1000), tone: b.tone, action, draft });
    await comms.aiLog(item.id, `compose:${action}`, req.session.user.username, 'ok', sanitizeString(b.instruction, 200) || null);
    res.json({ draft: out });
  } catch (err) {
    await comms.aiLog(item.id, `compose:${action}`, req.session.user.username, 'failed', err.message);
    throw err;
  }
}));

router.post('/items/:id/emails', sendLimiter, handle(async (req, res) => {
  const b = req.body || {};
  const kind = SEND_KINDS.includes(b.kind) ? b.kind : 'reply';
  const subject = sanitizeString(b.subject, 200).replace(/[\r\n]+/g, ' ');
  const body = sanitizeString(b.body, 6000);
  if (subject.length < 3) throw fail(400, 'Add a subject.');
  if (body.length < 10) throw fail(400, 'Write the message first.');
  const item = await loadItem(req.params.id);
  if (!item.email) throw fail(400, 'This customer did not leave an email address.');
  const row = await comms.createEmail(item, { kind, subject, body, author: req.session.user.username, aiGenerated: !!b.ai_assisted });
  const update = { updated_at: nowIso(), is_read: true };
  if (row.status === 'sent') {
    if (kind === 'info_request') update.awaiting_customer = true;
    if (kind === 'resolved') { update.status = 'resolved'; update.resolved_at = nowIso(); update.awaiting_customer = false; update.needs_attention = false; } else if (['new', 'under_review', 'in_progress'].includes(item.status)) update.status = 'responded';
  }
  must(await supabase.from('feedback').update(update).eq('id', item.id));
  logActivity(req.session.user, 'feedback_emailed', `Emailed ${item.reference} (${kind.replace('_', ' ')}): ${row.status}`);
  res.status(201).json({ email: emailOut(row) });
}));

// Customers answer by replying to the email; staff record the answer on the ticket
router.post('/items/:id/customer-reply', handle(async (req, res) => {
  const body = sanitizeString((req.body || {}).body, 6000);
  if (body.length < 2) throw fail(400, 'Paste the customer\'s reply first.');
  const item = await loadItem(req.params.id);
  const row = must(await supabase.from('feedback_emails').insert({ feedback_id: item.id, direction: 'inbound', kind: 'customer_reply', subject: `Customer reply (${item.reference})`, body, to_email: null, author: req.session.user.username, status: 'received' }).select('*').single());
  must(await supabase.from('feedback').update({ awaiting_customer: false, is_read: true, updated_at: nowIso(), ...(item.status === 'responded' ? { status: 'in_progress' } : {}) }).eq('id', item.id));
  logActivity(req.session.user, 'feedback_customer_reply', `Recorded a customer reply on ${item.reference}`);
  res.status(201).json({ email: emailOut(row) });
}));

router.post('/items/:id/confirmation/retry', sendLimiter, handle(async (req, res) => {
  const item = await loadItem(req.params.id);
  if (!item.email) throw fail(400, 'This customer did not leave an email address.');
  const existing = must(await supabase.from('feedback_emails').select('id, status').eq('feedback_id', item.id).eq('kind', 'confirmation').order('created_at', { ascending: false }).limit(1));
  if (existing[0] && existing[0].status === 'sent') throw fail(409, 'The confirmation email was already sent.');
  let row;
  if (existing[0]) row = await comms.deliver(existing[0].id, { manual: true });
  else {
    // Feedback that arrived before confirmations existed
    const { getSettings } = require('../mail/config');
    const c = comms.confirmationContent(item, item.product && item.product.name, await getSettings());
    row = await comms.createEmail(item, { kind: 'confirmation', subject: c.subject, body: c.body, author: req.session.user.username });
  }
  logActivity(req.session.user, 'feedback_confirmation_retry', `Confirmation for ${item.reference}: ${row.status}`);
  res.json({ email: emailOut(row) });
}));

// ---------- One email ----------
async function loadEmail(id) {
  const row = must(await supabase.from('feedback_emails').select('*').eq('id', id).maybeSingle());
  if (!row) throw fail(404, 'Email not found.');
  return row;
}

router.post('/emails/:id/approve', sendLimiter, handle(async (req, res) => {
  const row = await loadEmail(req.params.id);
  if (row.status !== 'pending_approval') throw fail(409, 'This email is no longer waiting for approval.');
  const b = req.body || {};
  const subject = b.subject !== undefined ? sanitizeString(b.subject, 200).replace(/[\r\n]+/g, ' ') : row.subject;
  let body = b.body !== undefined ? sanitizeString(b.body, 6000) : row.body;
  if (subject.length < 3 || body.length < 10) throw fail(400, 'The subject or message is empty.');
  // Customers are always told when an AI wrote the reply
  if (!body.includes(ai.AI_DISCLOSURE)) body = `${body}\n\n${ai.AI_DISCLOSURE}`;
  // Claim it first, so two people approving at once can't send it twice
  const claimed = must(await supabase.from('feedback_emails').update({ status: 'sending', subject, body, approved_by: req.session.user.username, updated_at: nowIso() }).eq('id', row.id).eq('status', 'pending_approval').select('id'));
  if (!claimed.length) throw fail(409, 'Someone else already handled this email.');
  const sent = await comms.deliver(row.id, { manual: true });
  if (sent.status === 'sent') {
    const item = must(await supabase.from('feedback').select('status').eq('id', row.feedback_id).single());
    must(await supabase.from('feedback').update({ ai_handled: true, updated_at: nowIso(), ...(['new', 'under_review', 'in_progress'].includes(item.status) ? { status: 'responded' } : {}) }).eq('id', row.feedback_id));
  }
  await comms.aiLog(row.feedback_id, 'approve_reply', req.session.user.username, sent.status === 'sent' ? 'ok' : 'failed', sent.error);
  logActivity(req.session.user, 'feedback_ai_reply_approved', `Approved an AI reply: ${sent.status}`);
  res.json({ email: emailOut(sent) });
}));

router.post('/emails/:id/discard', handle(async (req, res) => {
  const row = await loadEmail(req.params.id);
  if (row.status !== 'pending_approval') throw fail(409, 'Only a draft waiting for approval can be discarded.');
  must(await supabase.from('feedback_emails').update({ status: 'discarded', approved_by: req.session.user.username, updated_at: nowIso() }).eq('id', row.id));
  await comms.aiLog(row.feedback_id, 'discard_reply', req.session.user.username, 'ok', null);
  res.json({ success: true });
}));

router.post('/emails/:id/retry', sendLimiter, handle(async (req, res) => {
  const row = await loadEmail(req.params.id);
  if (row.direction !== 'outbound' || row.status !== 'failed') throw fail(409, 'Only a failed email can be retried.');
  const sent = await comms.deliver(row.id, { manual: true });
  logActivity(req.session.user, 'feedback_email_retry', `Retried an email (${row.kind}): ${sent.status}`);
  res.json({ email: emailOut(sent) });
}));

module.exports = router;
