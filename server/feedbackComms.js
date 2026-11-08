// server/feedbackComms.js
// Emails to customers about their feedback, and what happens after feedback arrives:
// confirmation email, AI analysis and (only when switched on) an automatic AI reply.
// Feedback is always saved first; nothing here can lose or block a submission.
const supabase = require('./database');
const { isMissingTableError } = require('./dbCompat');
const { getSettings, fromHeader, replyToHeader, mailEnv } = require('./mail/config');
const { getResend, classifyError } = require('./mail/resendClient');
const { buildMessage, esc } = require('./mail/render');
const { CATEGORIES } = require('./feedbackShared');
const ai = require('./feedbackAi');
const errorLog = require('./errorLog');

const MAX_AUTO_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];
const nowIso = () => new Date().toISOString();

// ---------- Is the 2026-11-09 database update in place? ----------
let ready = false;
let checkedAt = 0;
async function commsReady() {
  if (ready || Date.now() - checkedAt < 60000) return ready;
  checkedAt = Date.now();
  const [a, b] = await Promise.all([
    supabase.from('feedback').select('confirmation_status, ai_status').limit(1),
    supabase.from('feedback_emails').select('id').limit(1)
  ]);
  ready = !a.error && !b.error;
  return ready;
}
const COMMS_MIGRATION = { error: 'Customer emails and the AI assistant need the latest database update. Run database/migrations/2026-11-09-feedback-email-ai.sql.', code: 'MIGRATION_REQUIRED' };

// ---------- Settings ----------
const DEFAULT_AI_SETTINGS = { auto_reply_enabled: false, require_approval: true, status_emails_enabled: true };
async function getAiSettings() {
  const { data, error } = await supabase.from('feedback_ai_settings').select('auto_reply_enabled, require_approval, status_emails_enabled, updated_by, updated_at').eq('id', 1).maybeSingle();
  if (error && !isMissingTableError(error)) throw error;
  return { ...DEFAULT_AI_SETTINGS, ...(data || {}) };
}

async function aiLog(feedbackId, action, actor, outcome, detail) {
  await supabase.from('feedback_ai_log').insert({ feedback_id: feedbackId || null, action, actor, outcome, detail: detail ? String(detail).slice(0, 500) : null }).then(() => {}, () => {});
}

// ---------- Email content ----------
const paragraphs = (text) => String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

function contactLine(settings) {
  const env = mailEnv();
  const bits = [];
  const email = settings.contact_email || settings.reply_to || env.replyTo;
  if (email) bits.push(`email <a href="mailto:${esc(email)}">${esc(email)}</a>`);
  if (settings.contact_phone) bits.push(`call ${esc(settings.contact_phone)}`);
  bits.push(`visit <a href="${esc(env.baseUrl)}/contact">${esc(env.baseUrl.replace(/^https?:\/\//, ''))}/contact</a>`);
  return bits.join(', or ');
}

function confirmationContent(item, productName, settings) {
  const name = item.name ? item.name.split(/\s+/)[0] : 'there';
  const subject = `We received your feedback (${item.reference})`;
  const bodyHtml = `<h1>Thank you for your feedback</h1>
<p>Hello ${esc(name)},</p>
<p>Thank you for contacting SHEREBOY TECH LTD. We have received your feedback${productName ? ` about <strong>${esc(productName)}</strong>` : ''} and it has been saved safely.</p>
<p style="text-align:center"><strong>Your reference number: ${esc(item.reference)}</strong></p>
<p>Our team is now reviewing it. If we need more information, a member of our support team may contact you at this email address. Please keep your reference number if you get in touch about this feedback.</p>
<p><strong>What you sent:</strong> ${esc(CATEGORIES[item.category] || item.category)}: "${esc(item.subject)}"</p>
<p>For any other enquiries, you can reply to this email, ${contactLine(settings)}.</p>
<p>Kind regards,<br>SHEREBOY TECH LTD Support</p>`;
  const body = `Thank you for contacting SHEREBOY TECH LTD. We have received your feedback${productName ? ` about ${productName}` : ''}. Your reference number is ${item.reference}. Our team is reviewing it and may contact you if we need more information.`;
  return { subject, bodyHtml, body };
}

function statusContent(kind, item, productName) {
  const name = item.name ? item.name.split(/\s+/)[0] : 'there';
  if (kind === 'under_review') {
    return {
      subject: `Your feedback is being reviewed (${item.reference})`,
      body: `Hello ${name},\n\nThis is a quick update on your${productName ? ` ${productName}` : ''} feedback "${item.subject}" (reference ${item.reference}). A member of our team is now reviewing it.\n\nWe may contact you if we need more information. You can reply to this email at any time.\n\nKind regards,\nSHEREBOY TECH LTD Support`
    };
  }
  return {
    subject: `Your feedback has been resolved (${item.reference})`,
    body: `Hello ${name},\n\nWe have marked your${productName ? ` ${productName}` : ''} feedback "${item.subject}" (reference ${item.reference}) as resolved. Thank you for helping us improve.\n\nIf anything is still not right, simply reply to this email and quote your reference number, and our team will look at it again.\n\nKind regards,\nSHEREBOY TECH LTD Support`
  };
}

// ---------- Sending ----------
/**
 * Sends one recorded email and stores the real outcome on its row. The row id is
 * the idempotency key, so a retry after a lost reply never sends it twice.
 */
async function deliver(emailId, { manual = false } = {}) {
  const { data: row, error } = await supabase.from('feedback_emails').select('*').eq('id', emailId).maybeSingle();
  if (error) throw error;
  if (!row || row.direction !== 'outbound') return null;
  if (row.status === 'sent') return row;
  if (!manual && row.attempts >= MAX_AUTO_ATTEMPTS) return row;

  // Permanent failures set attempts to the maximum, which stops automatic retries
  const finish = async (fields) => {
    const update = { ...fields, attempts: fields.attempts ?? row.attempts + 1, updated_at: nowIso() };
    const { data } = await supabase.from('feedback_emails').update(update).eq('id', row.id).select('*');
    if (row.kind === 'confirmation') {
      await supabase.from('feedback').update({
        confirmation_status: fields.status === 'sent' ? 'sent' : 'failed',
        confirmation_attempts: Math.min(update.attempts, row.attempts + 1),
        confirmation_error: fields.error || null,
        ...(fields.status === 'sent' ? { confirmation_sent_at: fields.sent_at } : {})
      }).eq('id', row.feedback_id);
    }
    return (data && data[0]) || { ...row, ...update };
  };

  const settings = await getSettings();
  const resend = getResend();
  const from = fromHeader(settings);
  if (!resend || !from) return finish({ status: 'failed', error: 'Email sending is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL).' });
  const { data: blocked } = await supabase.from('email_suppressions').select('reason').eq('email', row.to_email).in('reason', ['bounced', 'complained']).maybeSingle();
  // A blocked address won't change by retrying, so automatic retries stop here
  if (blocked) return finish({ status: 'failed', error: `Not sent: this address ${blocked.reason === 'bounced' ? 'bounced' : 'reported our email as spam'} before.`, attempts: MAX_AUTO_ATTEMPTS });

  const { data: item } = await supabase.from('feedback').select('reference, name, category, subject, product:products(name)').eq('id', row.feedback_id).maybeSingle();
  const footerNote = item ? `This email is about your ${item.product ? `${item.product.name} ` : ''}feedback, reference ${item.reference}.` : '';
  // The confirmation has a designed layout; everything else is the text the team approved
  const bodyHtml = row.kind === 'confirmation' && item
    ? confirmationContent(item, item.product && item.product.name, settings).bodyHtml
    : paragraphs(row.body);
  const { html, text } = buildMessage({ subject: row.subject, preheader: row.kind === 'confirmation' ? `Reference ${item ? item.reference : ''}` : '', bodyHtml, settings, footerNote });
  const replyTo = replyToHeader(settings);
  try {
    const { data, error: sendError } = await resend.emails.send(
      { from, to: [row.to_email], subject: row.subject, html, text, ...(replyTo ? { replyTo } : {}), tags: [{ name: 'kind', value: `feedback_${row.kind}` }] },
      { idempotencyKey: `feedback-email/${row.id}` }
    );
    if (sendError) {
      const kind = classifyError(sendError);
      return finish({ status: 'failed', error: String(sendError.message || sendError.name).slice(0, 300), ...(kind === 'permanent' || kind === 'account' ? { attempts: MAX_AUTO_ATTEMPTS } : {}) });
    }
    return finish({ status: 'sent', error: null, provider_id: data && data.id ? data.id : null, sent_at: nowIso() });
  } catch (err) {
    return finish({ status: 'failed', error: String(err.message).slice(0, 300) });
  }
}

/** Retries a failed automatic email a few times in the background. */
function scheduleRetry(emailId, attempt = 0) {
  if (attempt >= RETRY_DELAYS_MS.length) return;
  const t = setTimeout(async () => {
    try {
      const row = await deliver(emailId);
      if (row && row.status === 'failed' && row.attempts < MAX_AUTO_ATTEMPTS) scheduleRetry(emailId, attempt + 1);
    } catch (err) { errorLog.record('feedback-email', `Retry failed: ${err.message}`); }
  }, RETRY_DELAYS_MS[attempt]);
  if (t.unref) t.unref();
}

/** Records an outbound email, then sends it (unless it waits for approval). */
async function createEmail(item, { kind, subject, body, author, aiGenerated = false, status = 'sending' }) {
  const { data, error } = await supabase.from('feedback_emails').insert({
    feedback_id: item.id, direction: 'outbound', kind, subject: String(subject).slice(0, 200), body, to_email: item.email,
    author, ai_generated: aiGenerated, status
  }).select('*').single();
  if (error) throw error;
  if (status !== 'sending') return data;
  return deliver(data.id, { manual: true });
}

/** Sends one status update per status, at most, and only when it is switched on. */
async function sendStatusEmail(item, status, actor) {
  if (!['under_review', 'resolved'].includes(status) || !item.email) return null;
  if (!(await commsReady())) return null;
  const settings = await getAiSettings();
  if (!settings.status_emails_enabled) return null;
  const { data: earlier } = await supabase.from('feedback_emails').select('id').eq('feedback_id', item.id).eq('kind', status).neq('status', 'discarded').limit(1);
  if (earlier && earlier.length) return null;
  const { subject, body } = statusContent(status, item, item.product && item.product.name);
  const row = await createEmail(item, { kind: status, subject, body, author: actor });
  if (row.status === 'failed') scheduleRetry(row.id);
  return row;
}

/** Before the 2026-11-09 update there is nowhere to record emails: send the confirmation anyway. */
async function sendUntrackedConfirmation(feedbackId) {
  const { data: item } = await supabase.from('feedback').select('id, reference, name, email, category, subject, product:products(name)').eq('id', feedbackId).maybeSingle();
  if (!item || !item.email) return;
  const settings = await getSettings();
  const resend = getResend();
  const from = fromHeader(settings);
  if (!resend || !from) return;
  const c = confirmationContent(item, item.product && item.product.name, settings);
  const { html, text } = buildMessage({ subject: c.subject, preheader: `Reference ${item.reference}`, bodyHtml: c.bodyHtml, settings, footerNote: `This email is about your feedback, reference ${item.reference}.` });
  const replyTo = replyToHeader(settings);
  const { error } = await resend.emails.send({ from, to: [item.email], subject: c.subject, html, text, ...(replyTo ? { replyTo } : {}), tags: [{ name: 'kind', value: 'feedback_confirmation' }] }, { idempotencyKey: `feedback-confirmation/${item.id}` });
  if (error) errorLog.record('feedback-email', `Confirmation for ${item.reference}: ${error.message || error.name}`);
}

// ---------- After new feedback is saved ----------
async function processNewFeedback(feedbackId) {
  if (!(await commsReady())) return sendUntrackedConfirmation(feedbackId);
  const { data: item } = await supabase.from('feedback').select('id, reference, name, email, rating, category, subject, message, status, source, product:products(name)').eq('id', feedbackId).maybeSingle();
  if (!item) return;
  const productName = item.product && item.product.name;

  // 1. Confirmation email
  if (item.email) {
    try {
      const settings = await getSettings();
      const c = confirmationContent(item, productName, settings);
      await supabase.from('feedback').update({ confirmation_status: 'pending' }).eq('id', item.id);
      const row = await createEmail(item, { kind: 'confirmation', subject: c.subject, body: c.body, author: 'system' });
      if (row.status === 'failed' && row.attempts < MAX_AUTO_ATTEMPTS) scheduleRetry(row.id);
    } catch (err) { errorLog.record('feedback-email', `Confirmation for ${item.reference}: ${err.message}`); }
  }

  // 2. AI analysis
  if (!ai.aiConfigured()) { await supabase.from('feedback').update({ ai_status: 'off' }).eq('id', item.id); return; }
  let analysis;
  try {
    analysis = await ai.analyzeFeedback(item, productName);
    await supabase.from('feedback').update({
      ai_classification: analysis.classification, sentiment: analysis.sentiment, ai_summary: analysis.summary,
      ai_follow_up_questions: analysis.follow_up_questions, ai_suggested_reply: analysis.suggested_reply,
      needs_attention: analysis.needs_attention, attention_reason: analysis.attention_reason,
      ai_status: 'done', ai_analyzed_at: nowIso()
    }).eq('id', item.id);
    await aiLog(item.id, 'analyze', 'system', 'ok', `${analysis.classification}, ${analysis.sentiment}${analysis.needs_attention ? ', needs attention' : ''}`);
  } catch (err) {
    await supabase.from('feedback').update({ ai_status: 'failed' }).eq('id', item.id);
    await aiLog(item.id, 'analyze', 'system', 'failed', err.message);
    return;
  }

  // 3. Automatic AI reply, only when an administrator switched it on
  const settings = await getAiSettings();
  if (!settings.auto_reply_enabled) return;
  const check = ai.autoReplyCheck(item, analysis);
  if (!check.ok) { await aiLog(item.id, 'auto_reply', 'system', 'held', check.reason); return; }
  const body = `${analysis.suggested_reply}\n\n${ai.AI_DISCLOSURE}`;
  const subject = `Re: ${item.subject} (${item.reference})`;
  try {
    const row = await createEmail(item, { kind: 'ai_reply', subject, body, author: 'AI assistant', aiGenerated: true, status: settings.require_approval ? 'pending_approval' : 'sending' });
    if (row.status === 'sent') {
      await supabase.from('feedback').update({ ai_handled: true, status: item.status === 'new' ? 'responded' : item.status, updated_at: nowIso() }).eq('id', item.id);
    } else if (row.status === 'failed') scheduleRetry(row.id);
    await aiLog(item.id, 'auto_reply', 'system', row.status === 'failed' ? 'failed' : 'ok', row.status === 'pending_approval' ? 'Draft waiting for approval' : row.status === 'sent' ? 'Sent automatically' : row.error);
  } catch (err) { await aiLog(item.id, 'auto_reply', 'system', 'failed', err.message); }
}

/** Runs after the response is sent, so the customer never waits for email or AI. */
function afterSubmit(feedbackId) {
  setImmediate(() => processNewFeedback(feedbackId).catch(err => errorLog.record('feedback', `After-submit: ${err.message}`)));
}

/** Catches failed emails whose in-memory retry was lost (for example a restart). */
async function sweepFailedEmails() {
  if (!(await commsReady())) return;
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data } = await supabase.from('feedback_emails').select('id, attempts, updated_at').eq('status', 'failed').eq('direction', 'outbound').lt('attempts', MAX_AUTO_ATTEMPTS).gte('created_at', since).limit(20);
  for (const row of data || []) {
    if (Date.now() - Date.parse(row.updated_at) < 10 * 60 * 1000) continue;
    await deliver(row.id).catch(() => {});
  }
}
function startSweeper() {
  const t = setInterval(() => sweepFailedEmails().catch(() => {}), 15 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { commsReady, COMMS_MIGRATION, getAiSettings, aiLog, deliver, createEmail, scheduleRetry, sendStatusEmail, processNewFeedback, afterSubmit, sweepFailedEmails, startSweeper, MAX_AUTO_ATTEMPTS, confirmationContent };
