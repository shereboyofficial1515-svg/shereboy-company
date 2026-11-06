// server/routes/feedbackAdmin.js
// The Reviews & Feedback module of the admin dashboard. Staff (administrators and
// editors) manage feedback; deleting feedback and bulk exports are for administrators.
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth, requireRole } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString, sanitizeUrl } = require('../middleware/security');
const { isMissingTableError } = require('../dbCompat');
const { CATEGORIES, STATUSES, SLUG_RE, MIGRATION } = require('../feedbackShared');
const { getSettings, fromHeader, replyToHeader } = require('../mail/config');
const { getResend } = require('../mail/resendClient');
const { buildMessage } = require('../mail/render');
const errorLog = require('../errorLog');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nowIso = () => new Date().toISOString();
const PAGE = 1000;

router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.param('id', (req, res, next, id) => (UUID_RE.test(id) ? next() : res.status(404).json({ error: 'Not found.' })));

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (isMissingTableError(err)) return res.status(409).json(MIGRATION);
    if (err.status) return res.status(err.status).json({ error: err.message });
    errorLog.record('feedback', err.message, { method: req.method, path: req.route && req.route.path });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
const must = ({ data, error }) => { if (error) throw error; return data; };
const fail = (status, message) => Object.assign(new Error(message), { status });

/** Every feedback row (summary columns), for statistics computed from real records. */
async function allFeedback(columns = 'id, product_id, rating, category, status, is_read, suspected_spam, subject, created_at') {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const data = must(await supabase.from('feedback').select(columns).order('created_at', { ascending: true }).range(from, from + PAGE - 1));
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}
const allProducts = async () => must(await supabase.from('products').select('*').order('display_order', { ascending: true }).order('name', { ascending: true }));

function lastMonths(n) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push({ key: m.toISOString().slice(0, 7), label: m.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }) });
  }
  return out;
}
const avg = (list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);

// ---------- Overview ----------
router.get('/overview', handle(async (req, res) => {
  const [rows, products] = await Promise.all([allFeedback(), allProducts()]);
  const months = lastMonths(12).map(m => {
    const inMonth = rows.filter(r => r.created_at.slice(0, 7) === m.key);
    return { ...m, count: inMonth.length, avgRating: avg(inMonth.map(r => r.rating)) };
  });
  const byProduct = products.map(p => {
    const list = rows.filter(r => r.product_id === p.id);
    return { id: p.id, name: p.name, count: list.length, avgRating: avg(list.map(r => r.rating)), complaints: list.filter(r => r.category === 'complaint').length };
  });
  res.json({
    total: rows.length,
    unread: rows.filter(r => !r.is_read).length,
    new: rows.filter(r => r.status === 'new').length,
    pending: rows.filter(r => ['new', 'under_review', 'in_progress'].includes(r.status)).length,
    resolved: rows.filter(r => r.status === 'resolved').length,
    avgRating: avg(rows.map(r => r.rating)),
    productsWithFeedback: byProduct.filter(p => p.count).length,
    months,
    ratings: [1, 2, 3, 4, 5].map(n => ({ rating: n, count: rows.filter(r => r.rating === n).length })),
    categories: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label, count: rows.filter(r => r.category === key).length })),
    byProduct
  });
}));

// ---------- Feedback list ----------
function applyFilters(q, f) {
  let query = q;
  if (f.product && UUID_RE.test(f.product)) query = query.eq('product_id', f.product);
  if (CATEGORIES[f.category]) query = query.eq('category', f.category);
  if (/^[1-5]$/.test(f.rating || '')) query = query.eq('rating', Number(f.rating));
  if (STATUSES.includes(f.status)) query = query.eq('status', f.status);
  else if (f.status !== 'all') query = query.neq('status', 'archived');
  if (f.read === 'unread') query = query.eq('is_read', false);
  if (f.read === 'read') query = query.eq('is_read', true);
  if (Date.parse(f.from)) query = query.gte('created_at', new Date(f.from).toISOString());
  if (Date.parse(f.to)) query = query.lte('created_at', new Date(Date.parse(f.to) + 86399999).toISOString());
  const term = String(f.q || '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 80);
  if (term) query = query.or(`reference.ilike.%${term}%,subject.ilike.%${term}%,message.ilike.%${term}%,name.ilike.%${term}%,email.ilike.%${term}%`);
  return query;
}

router.get('/items', handle(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const { data, error, count } = await applyFilters(supabase.from('feedback').select('id, reference, product_id, name, email, rating, category, subject, status, is_read, suspected_spam, allow_publish, created_at, product:products(name)', { count: 'exact' }), req.query)
    .order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  if (error) throw error;
  res.json({ items: data || [], total: count || 0, page, limit });
}));

router.get('/items/:id', handle(async (req, res) => {
  const item = must(await supabase.from('feedback').select('id, reference, product_id, name, email, rating, category, subject, message, allow_publish, status, is_read, suspected_spam, resolved_at, created_at, updated_at, product:products(name, slug)').eq('id', req.params.id).maybeSingle());
  if (!item) throw fail(404, 'Feedback not found.');
  const [attachments, responses, notes, testimonial] = await Promise.all([
    supabase.from('feedback_attachments').select('id, file_name, mime_type, size_bytes, created_at').eq('feedback_id', item.id).order('created_at', { ascending: true }),
    supabase.from('feedback_responses').select('id, message, admin_username, email_status, email_error, created_at').eq('feedback_id', item.id).order('created_at', { ascending: true }),
    supabase.from('feedback_internal_notes').select('id, note, admin_username, created_at').eq('feedback_id', item.id).order('created_at', { ascending: true }),
    supabase.from('testimonials').select('id, status, featured').eq('feedback_id', item.id).maybeSingle()
  ]);
  // Opening feedback marks it as read
  if (!item.is_read) { await supabase.from('feedback').update({ is_read: true }).eq('id', item.id); item.is_read = true; }
  res.json({ item, attachments: attachments.data || [], responses: responses.data || [], notes: notes.data || [], testimonial: testimonial.data || null, emailReady: !!(getResend() && fromHeader(await getSettings())) });
}));

router.patch('/items/:id', handle(async (req, res) => {
  const b = req.body || {};
  const update = { updated_at: nowIso() };
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw fail(400, 'Unknown status.');
    update.status = b.status;
    update.resolved_at = b.status === 'resolved' ? nowIso() : null;
  }
  if (b.is_read !== undefined) update.is_read = !!b.is_read;
  const data = must(await supabase.from('feedback').update(update).eq('id', req.params.id).select('id, reference, status, is_read'));
  if (!data.length) throw fail(404, 'Feedback not found.');
  if (update.status) logActivity(req.session.user, 'feedback_status_changed', `${data[0].reference} marked ${update.status.replace('_', ' ')}`);
  res.json({ item: data[0] });
}));

router.delete('/items/:id', requireRole('admin'), handle(async (req, res) => {
  const item = must(await supabase.from('feedback').select('id, reference').eq('id', req.params.id).maybeSingle());
  if (!item) throw fail(404, 'Feedback not found.');
  const files = must(await supabase.from('feedback_attachments').select('bucket, storage_path').eq('feedback_id', item.id));
  for (const bucket of [...new Set(files.map(f => f.bucket))]) {
    await supabase.storage.from(bucket).remove(files.filter(f => f.bucket === bucket).map(f => f.storage_path));
  }
  must(await supabase.from('feedback').delete().eq('id', item.id));
  logActivity(req.session.user, 'feedback_deleted', `Deleted feedback ${item.reference}`);
  res.json({ success: true });
}));

// Short-lived link: attachments are in a private bucket and never public
router.get('/attachments/:id', handle(async (req, res) => {
  const file = must(await supabase.from('feedback_attachments').select('bucket, storage_path, file_name').eq('id', req.params.id).maybeSingle());
  if (!file) throw fail(404, 'Attachment not found.');
  const { data, error } = await supabase.storage.from(file.bucket).createSignedUrl(file.storage_path, 300, { download: file.file_name });
  if (error || !data) throw new Error('Could not open the attachment.');
  res.json({ url: data.signedUrl, expiresIn: 300 });
}));

router.post('/items/:id/notes', handle(async (req, res) => {
  const note = sanitizeString((req.body || {}).note, 3000);
  if (!note) throw fail(400, 'Write a note first.');
  const exists = must(await supabase.from('feedback').select('id').eq('id', req.params.id).maybeSingle());
  if (!exists) throw fail(404, 'Feedback not found.');
  const row = must(await supabase.from('feedback_internal_notes').insert({ feedback_id: req.params.id, note, admin_username: req.session.user.username }).select('id, note, admin_username, created_at').single());
  res.status(201).json({ note: row });
}));

// Replies are recorded first; the email is an extra, and its real outcome is stored
router.post('/items/:id/responses', handle(async (req, res) => {
  const b = req.body || {};
  const message = sanitizeString(b.message, 5000);
  if (message.length < 2) throw fail(400, 'Write a reply first.');
  const item = must(await supabase.from('feedback').select('id, reference, email, name, status, subject, product:products(name)').eq('id', req.params.id).maybeSingle());
  if (!item) throw fail(404, 'Feedback not found.');
  if (b.send_email && !item.email) throw fail(400, 'This customer did not leave an email address.');

  let emailStatus = 'not_sent';
  let emailError = null;
  if (b.send_email) {
    const settings = await getSettings();
    const resend = getResend();
    const from = fromHeader(settings);
    const { data: blocked } = await supabase.from('email_suppressions').select('reason').eq('email', item.email).in('reason', ['bounced', 'complained']).maybeSingle();
    if (!resend || !from) { emailStatus = 'failed'; emailError = 'Email sending is not configured.'; } else if (blocked) { emailStatus = 'failed'; emailError = `Not sent: this address ${blocked.reason === 'bounced' ? 'bounced' : 'reported our email as spam'} before.`; } else {
      const subject = `Re: ${item.subject} [${item.reference}]`;
      const paragraphs = message.split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('');
      const { html, text } = buildMessage({ subject, bodyHtml: `<p>Hello ${(item.name || 'there').replace(/[<>&"]/g, '')},</p>${paragraphs}`, settings, footerNote: `This is a reply to your ${item.product ? item.product.name : ''} feedback, reference ${item.reference}.` });
      const replyTo = replyToHeader(settings);
      try {
        const { error } = await resend.emails.send({ from, to: [item.email], subject, html, text, ...(replyTo ? { replyTo } : {}), tags: [{ name: 'kind', value: 'feedback_reply' }] });
        if (error) { emailStatus = 'failed'; emailError = String(error.message || error.name).slice(0, 300); } else emailStatus = 'accepted';
      } catch (err) { emailStatus = 'failed'; emailError = err.message.slice(0, 300); }
    }
  }
  const row = must(await supabase.from('feedback_responses').insert({ feedback_id: item.id, message, admin_username: req.session.user.username, email_status: emailStatus, email_error: emailError }).select('id, message, admin_username, email_status, email_error, created_at').single());
  if (['new', 'under_review', 'in_progress'].includes(item.status)) await supabase.from('feedback').update({ status: 'responded', is_read: true, updated_at: nowIso() }).eq('id', item.id);
  logActivity(req.session.user, 'feedback_responded', `Replied to ${item.reference}${emailStatus === 'accepted' ? ' by email' : ''}`);
  res.status(201).json({ response: row });
}));

// ---------- Export ----------
router.get('/export.csv', requireRole('admin'), handle(async (req, res) => {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await applyFilters(supabase.from('feedback').select('reference, created_at, product:products(name), rating, category, status, subject, message, name, email, allow_publish'), { ...req.query, status: req.query.status || 'all' })
      .order('created_at', { ascending: false }).range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  const cell = (v) => `"${String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
  const head = ['Reference', 'Date', 'Product', 'Rating', 'Category', 'Status', 'Subject', 'Feedback', 'Name', 'Email', 'May publish'];
  const lines = rows.map(r => [r.reference, r.created_at, r.product ? r.product.name : '', r.rating, CATEGORIES[r.category] || r.category, r.status, r.subject, r.message, r.name, r.email, r.allow_publish ? 'yes' : 'no'].map(cell).join(','));
  logActivity(req.session.user, 'feedback_exported', `Exported ${rows.length} feedback record(s)`);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="feedback-${new Date().toISOString().slice(0, 10)}.csv"`);
  // The byte-order mark lets Excel read names and accents correctly
  res.send(`﻿${[head.map(cell).join(','), ...lines].join('\r\n')}`);
}));

// ---------- Products ----------
router.get('/products', handle(async (req, res) => {
  const [products, rows] = await Promise.all([allProducts(), allFeedback('id, product_id, rating, category')]);
  res.json({
    products: products.map(p => {
      const list = rows.filter(r => r.product_id === p.id);
      return { ...p, feedbackCount: list.length, avgRating: avg(list.map(r => r.rating)), complaints: list.filter(r => r.category === 'complaint').length };
    })
  });
}));

function productPayload(b, partial) {
  const out = { updated_at: nowIso() };
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) { out.name = sanitizeString(b.name, 100); if (!out.name) throw fail(400, 'Give the product a name.'); }
  if (has('slug')) {
    out.slug = String(b.slug || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!SLUG_RE.test(out.slug)) throw fail(400, 'The link name may use lowercase letters, numbers and dashes.');
  }
  if (has('description')) out.description = sanitizeString(b.description, 1000) || null;
  for (const k of ['logo_url', 'website_url']) {
    if (!has(k)) continue;
    const url = sanitizeUrl(b[k], 1000);
    if (b[k] && !/^https:\/\//.test(url)) throw fail(400, `${k === 'logo_url' ? 'The logo' : 'The website'} must be a full https:// address.`);
    out[k] = url || null;
  }
  if (b.is_active !== undefined) out.is_active = !!b.is_active;
  if (b.display_order !== undefined) out.display_order = Math.max(0, Math.min(parseInt(b.display_order, 10) || 0, 1000));
  return out;
}

router.post('/products', handle(async (req, res) => {
  const payload = productPayload({ ...req.body, slug: (req.body || {}).slug || (req.body || {}).name }, false);
  const { data, error } = await supabase.from('products').insert(payload).select('*').single();
  if (error) { if (error.code === '23505') throw fail(400, 'Another product already uses that link name.'); throw error; }
  logActivity(req.session.user, 'product_created', `Added product "${data.name}"`);
  res.status(201).json({ product: data });
}));

router.put('/products/:id', handle(async (req, res) => {
  const payload = productPayload(req.body || {}, true);
  const { data, error } = await supabase.from('products').update(payload).eq('id', req.params.id).select('*');
  if (error) { if (error.code === '23505') throw fail(400, 'Another product already uses that link name.'); throw error; }
  if (!data.length) throw fail(404, 'Product not found.');
  logActivity(req.session.user, 'product_updated', `Updated product "${data[0].name}"${payload.is_active === false ? ' (deactivated)' : ''}`);
  res.json({ product: data[0] });
}));

// Products with feedback can only be deactivated, so no feedback is ever orphaned
router.delete('/products/:id', requireRole('admin'), handle(async (req, res) => {
  const { count } = await supabase.from('feedback').select('id', { count: 'exact', head: true }).eq('product_id', req.params.id);
  if (count) throw fail(409, 'This product has feedback. Deactivate it instead, so its history is kept.');
  const data = must(await supabase.from('products').delete().eq('id', req.params.id).select('name'));
  if (!data.length) throw fail(404, 'Product not found.');
  logActivity(req.session.user, 'product_deleted', `Deleted product "${data[0].name}"`);
  res.json({ success: true });
}));

// ---------- Testimonials ----------
router.get('/testimonials', handle(async (req, res) => {
  let q = supabase.from('testimonials').select('id, feedback_id, status, featured, display_name, quote, rating, approved_by, approved_at, created_at, product:products(id, name), feedback:feedback(reference, allow_publish)').order('created_at', { ascending: false }).limit(200);
  if (['pending', 'approved', 'rejected', 'unpublished'].includes(req.query.status)) q = q.eq('status', req.query.status);
  if (UUID_RE.test(req.query.product || '')) q = q.eq('product_id', req.query.product);
  if (req.query.positive === '1') q = q.gte('rating', 4);
  res.json({ testimonials: must(await q) });
}));

router.patch('/testimonials/:id', handle(async (req, res) => {
  const b = req.body || {};
  const t = must(await supabase.from('testimonials').select('id, status, display_name, feedback:feedback(allow_publish, reference)').eq('id', req.params.id).maybeSingle());
  if (!t) throw fail(404, 'Testimonial not found.');
  const update = { updated_at: nowIso() };
  if (b.status !== undefined) {
    if (!['pending', 'approved', 'rejected', 'unpublished'].includes(b.status)) throw fail(400, 'Unknown status.');
    // Permission is checked again here, not just when the candidate was created
    if (b.status === 'approved' && !(t.feedback && t.feedback.allow_publish)) throw fail(403, 'The customer did not give permission to publish this.');
    update.status = b.status;
    if (b.status === 'approved') { update.approved_by = req.session.user.username; update.approved_at = nowIso(); }
    if (b.status !== 'approved') update.featured = false;
  }
  if (b.featured !== undefined) {
    if (b.featured && (update.status || t.status) !== 'approved') throw fail(400, 'Only an approved testimonial can be featured.');
    update.featured = !!b.featured;
  }
  const data = must(await supabase.from('testimonials').update(update).eq('id', t.id).select('id, status, featured'));
  logActivity(req.session.user, 'testimonial_updated', `Testimonial for ${t.feedback ? t.feedback.reference : ''}: ${update.status || (update.featured ? 'featured' : 'unfeatured')}`);
  res.json({ testimonial: data[0] });
}));

// ---------- Analytics ----------
const STOP = new Set('a an and are as at be but by can cannot could do does for from get has have how i if in into is it its my no not of on or our please should so that the their them there this to too was we what when where which why will with would you your app page just very also still any'.split(' '));
function topWords(subjects, n = 8) {
  const counts = {};
  subjects.forEach(s => new Set(String(s).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).forEach(w => { if (!STOP.has(w)) counts[w] = (counts[w] || 0) + 1; }));
  return Object.entries(counts).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, n).map(([word, count]) => ({ word, count }));
}

router.get('/analytics', handle(async (req, res) => {
  const [rows, products] = await Promise.all([allFeedback(), allProducts()]);
  const stats = products.map(p => {
    const list = rows.filter(r => r.product_id === p.id);
    return { name: p.name, count: list.length, avgRating: avg(list.map(r => r.rating)), complaints: list.filter(r => r.category === 'complaint').length, bugs: list.filter(r => r.category === 'bug').length, features: list.filter(r => r.category === 'feature').length };
  });
  const pick = (key, filter = () => true) => stats.filter(s => s[key] && filter(s)).sort((a, b) => b[key] - a[key])[0] || null;
  res.json({
    mostReviewed: pick('count'),
    // Small samples mislead, so a product needs at least 3 ratings to rank
    highestRated: pick('avgRating', s => s.count >= 3),
    mostComplaints: pick('complaints'),
    commonProblems: topWords(rows.filter(r => r.category === 'bug' || r.category === 'complaint').map(r => r.subject)),
    requestedFeatures: topWords(rows.filter(r => r.category === 'feature' || r.category === 'suggestion').map(r => r.subject)),
    satisfaction: lastMonths(12).map(m => { const inMonth = rows.filter(r => r.created_at.slice(0, 7) === m.key); return { ...m, avgRating: avg(inMonth.map(r => r.rating)), count: inMonth.length }; }),
    byProduct: stats
  });
}));

module.exports = router;
