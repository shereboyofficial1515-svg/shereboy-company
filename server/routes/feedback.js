// server/routes/feedback.js
// Public feedback: the product list, the submission form and approved testimonials.
// No account is needed. Nothing private (emails, notes, attachments) is ever returned.
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const router = express.Router();
const supabase = require('../database');
const { rateLimit, sanitizeString } = require('../middleware/security');
const { isMissingTableError } = require('../dbCompat');
const { TYPES, PRIVATE_BUCKET, bucketProblem, safeDisplayName } = require('../uploadStore');
const { normalizeEmail } = require('../mail/subscribers');
const { clientIp } = require('../clientIp');
const { CATEGORIES, SLUG_RE, MIGRATION, testimonialName } = require('../feedbackShared');
const { notifyNewFeedback } = require('../email');
const errorLog = require('../errorLog');

const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const keyed = (v) => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'feedback').update(String(v)).digest('hex').slice(0, 32);

const submitLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'You have sent several pieces of feedback recently. Please try again later.' } });

const receiveFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 20, fieldSize: 20000 },
  fileFilter: (req, file, cb) => (TYPES[file.mimetype] ? cb(null, true) : cb(Object.assign(new Error('Attachments must be JPEG, PNG, WEBP or GIF images, or PDF documents.'), { status: 400 })))
}).array('attachments', MAX_FILES);

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// GET /api/feedback/products — active products only, for the form
router.get('/products', async (req, res) => {
  const { data, error } = await supabase.from('products').select('slug, name, description, logo_url, website_url').eq('is_active', true).order('display_order', { ascending: true }).order('name', { ascending: true });
  if (error) return isMissingTableError(error) ? res.status(503).json({ ...MIGRATION, error: 'Feedback is not open yet. Please check back soon.' }) : res.status(500).json({ error: 'Could not load products.' });
  res.json({ products: data || [], categories: CATEGORIES });
});

// GET /api/feedback/testimonials?product=&featured=1 — approved, and only with the customer's permission
router.get('/testimonials', async (req, res) => {
  let q = supabase.from('testimonials').select('display_name, quote, rating, featured, approved_at, product:products(name, slug)').eq('status', 'approved')
    .order('featured', { ascending: false }).order('approved_at', { ascending: false }).limit(Math.min(parseInt(req.query.limit, 10) || 12, 24));
  if (req.query.featured === '1') q = q.eq('featured', true);
  const { data, error } = await q;
  if (error) return isMissingTableError(error) ? res.json({ testimonials: [] }) : res.status(500).json({ error: 'Could not load testimonials.' });
  let list = data || [];
  const slug = String(req.query.product || '');
  if (slug && SLUG_RE.test(slug)) list = list.filter(t => t.product && t.product.slug === slug);
  res.json({ testimonials: list.map(t => ({ name: t.display_name, quote: t.quote, rating: t.rating, featured: t.featured, product: t.product ? t.product.name : null, date: t.approved_at })) });
});

function newReference() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const code = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 6);
  return `FB-${day}-${code}`;
}

// POST /api/feedback — multipart form, attachments optional
router.post('/', submitLimiter, (req, res, next) => receiveFiles(req, res, (err) => {
  if (!err) return next();
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each attachment can be up to 5MB.' : err.code === 'LIMIT_FILE_COUNT' ? `You can attach up to ${MAX_FILES} files.` : (err.status ? err.message : 'The form could not be read. Please try again.');
  return res.status(400).json({ error: message });
}), async (req, res) => {
  const b = req.body || {};
  const files = req.files || [];
  // Bots fill the hidden field: they get a normal-looking reply, and nothing is saved
  if (b.website) return res.status(201).json({ success: true, reference: newReference() });

  const slug = String(b.product || '');
  const rating = Number(b.rating);
  const category = String(b.category || '');
  const subject = sanitizeString(b.subject, 150);
  const message = sanitizeString(b.message, 5000);
  const name = sanitizeString(b.name, 100);
  const email = b.email ? normalizeEmail(b.email) : null;
  const allowPublish = b.allow_publish === 'true' || b.allow_publish === true;

  const problems = [];
  if (!SLUG_RE.test(slug)) problems.push('Choose the product you are giving feedback on.');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) problems.push('Choose a rating from 1 to 5 stars.');
  if (!CATEGORIES[category]) problems.push('Choose a feedback category.');
  if (subject.length < 3) problems.push('Add a short subject.');
  if (message.length < 10) problems.push('Please describe your feedback in at least 10 characters.');
  if (b.email && !email) problems.push('The email address is not valid. You can also leave it empty.');
  if (problems.length) return res.status(400).json({ error: problems[0], errors: problems });

  for (const f of files) {
    if (!TYPES[f.mimetype].sig(f.buffer)) return res.status(400).json({ error: `"${safeDisplayName(f.originalname)}" doesn't look like a genuine image or PDF.` });
  }

  try {
    const { data: product, error: pErr } = await supabase.from('products').select('id, name, is_active').eq('slug', slug).maybeSingle();
    if (pErr) { if (isMissingTableError(pErr)) return res.status(503).json({ error: 'Feedback is not open yet. Please check back soon.' }); throw pErr; }
    if (!product || !product.is_active) return res.status(400).json({ error: 'That product is not available for feedback.' });

    // The same message twice from the same visitor within minutes is a double submit
    const submitterHash = keyed(clientIp(req));
    const contentHash = keyed(`${slug}:${subject}:${message}`);
    const { data: dup } = await supabase.from('feedback').select('reference, created_at').eq('submitter_hash', submitterHash).eq('content_hash', contentHash).order('created_at', { ascending: false }).limit(1);
    if (dup && dup[0] && Date.now() - Date.parse(dup[0].created_at) < DUPLICATE_WINDOW_MS) return res.status(200).json({ success: true, reference: dup[0].reference, duplicate: true });

    const id = crypto.randomUUID();
    let stored = [];
    if (files.length) {
      const problem = await bucketProblem(PRIVATE_BUCKET, false);
      if (problem) {
        errorLog.record('feedback', problem);
        return res.status(503).json({ error: 'We can\'t accept attachments right now. Please send your feedback without them.' });
      }
      for (const f of files) {
        const path = `feedback/${id}/${crypto.randomBytes(8).toString('hex')}.${TYPES[f.mimetype].ext}`;
        const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, f.buffer, { contentType: f.mimetype, upsert: false });
        if (error) {
          if (stored.length) await supabase.storage.from(PRIVATE_BUCKET).remove(stored.map(s => s.storage_path));
          throw new Error(`Attachment upload failed: ${error.message}`);
        }
        stored.push({ feedback_id: id, bucket: PRIVATE_BUCKET, storage_path: path, file_name: safeDisplayName(f.originalname), mime_type: f.mimetype, size_bytes: f.size });
      }
    }

    const links = (message.match(/https?:\/\//gi) || []).length;
    let reference;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      reference = newReference();
      const { error } = await supabase.from('feedback').insert({
        id, reference, product_id: product.id, name: name || null, email, rating, category, subject, message,
        allow_publish: allowPublish, status: 'new', is_read: false, suspected_spam: links > 3, submitter_hash: submitterHash, content_hash: contentHash
      });
      if (!error) break;
      if (error.code !== '23505' || attempt === 2) {
        if (stored.length) await supabase.storage.from(PRIVATE_BUCKET).remove(stored.map(s => s.storage_path));
        throw new Error(`Could not save feedback: ${error.message}`);
      }
    }
    if (stored.length) await supabase.from('feedback_attachments').insert(stored);
    // A candidate only: nothing is published until an administrator approves it
    if (allowPublish) {
      await supabase.from('testimonials').insert({ feedback_id: id, product_id: product.id, status: 'pending', display_name: testimonialName(name, product.name), quote: message, rating });
    }
    notifyNewFeedback({ reference, product: product.name, rating, category: CATEGORIES[category], subject }).catch(() => {});
    res.status(201).json({ success: true, reference });
  } catch (err) {
    errorLog.record('feedback', err.message);
    console.error('[feedback] submission failed:', err.message);
    res.status(500).json({ error: 'We could not save your feedback just now. Please try again.' });
  }
});

module.exports = router;
