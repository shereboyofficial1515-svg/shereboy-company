// server/routes/media.js
// Admin media library: list, describe, replace, delete and (for private
// documents) open uploaded files. Backed by the media_assets table from the
// 2026-10-29 migration.
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth, requireRole } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString, uploadLimiter } = require('../middleware/security');
const { isMissingTableError } = require('../dbCompat');
const { receiveFile, storeFile, safeDisplayName } = require('../uploadStore');

const MIGRATION_MSG = {
  error: 'The media library needs the latest database update. Run database/migrations/2026-10-29-portfolio-media-admin.sql in the Supabase SQL editor.',
  code: 'MIGRATION_REQUIRED'
};

router.use(requireAuth);

// GET /api/media?type=image|pdf&search=&page=
router.get('/', async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 24, 60);
  let query = supabase.from('media_assets').select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  if (req.query.type === 'image') query = query.like('mime_type', 'image/%');
  if (req.query.type === 'pdf') query = query.eq('mime_type', 'application/pdf');
  if (req.query.search) {
    const term = String(req.query.search).replace(/[%,()]/g, '').slice(0, 80);
    query = query.or(`file_name.ilike.%${term}%,description.ilike.%${term}%`);
  }
  const { data, error, count } = await query;
  if (error) {
    if (isMissingTableError(error)) return res.status(409).json(MIGRATION_MSG);
    return res.status(500).json({ error: 'Failed to load the media library.' });
  }
  res.json({ assets: data, total: count, page, limit });
});

async function findAsset(id) {
  const { data, error } = await supabase.from('media_assets').select('*').eq('id', id).single();
  if (error && isMissingTableError(error)) return { migration: true };
  return { asset: data || null };
}

// GET /api/media/:id/open — short-lived link (signed for private documents)
router.get('/:id/open', async (req, res) => {
  const { asset, migration } = await findAsset(req.params.id);
  if (migration) return res.status(409).json(MIGRATION_MSG);
  if (!asset) return res.status(404).json({ error: 'File not found.' });
  if (!asset.is_private) return res.json({ url: asset.url });
  const { data, error } = await supabase.storage.from(asset.bucket).createSignedUrl(asset.storage_path, 300);
  if (error || !data) return res.status(500).json({ error: 'Could not open this private document.' });
  res.set('Cache-Control', 'no-store');
  res.json({ url: data.signedUrl, expiresIn: 300 });
});

// PUT /api/media/:id — update description (alt text)
router.put('/:id', async (req, res) => {
  const description = sanitizeString(req.body?.description, 300);
  const { data, error } = await supabase.from('media_assets')
    .update({ description: description || null, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error && isMissingTableError(error)) return res.status(409).json(MIGRATION_MSG);
  if (error || !data) return res.status(404).json({ error: 'File not found.' });
  logActivity(req.session.user, 'media_edited', `Updated description of "${data.file_name}"`);
  res.json({ asset: data });
});

// POST /api/media/:id/replace — overwrite the stored file in place, so every
// page that references its URL picks up the new version.
router.post('/:id/replace', uploadLimiter, async (req, res) => {
  const { asset, migration } = await findAsset(req.params.id);
  if (migration) return res.status(409).json(MIGRATION_MSG);
  if (!asset) return res.status(404).json({ error: 'File not found.' });

  const file = await receiveFile(req, res);
  if (!file) return;
  const sameKind = (asset.mime_type === 'application/pdf') === (file.mimetype === 'application/pdf');
  if (!sameKind) return res.status(400).json({ error: asset.mime_type === 'application/pdf' ? 'Replace a PDF with another PDF.' : 'Replace an image with another image.' });

  const stored = await storeFile(file, { existingPath: asset.storage_path, bucket: asset.bucket, isPrivate: asset.is_private });
  if (stored.error) return res.status(500).json({ error: stored.error });

  const { data } = await supabase.from('media_assets').update({
    mime_type: file.mimetype,
    size_bytes: file.size,
    file_name: safeDisplayName(file.originalname),
    updated_at: new Date().toISOString()
  }).eq('id', asset.id).select().single();
  logActivity(req.session.user, 'media_replaced', `Replaced file "${asset.file_name}"`);
  res.json({ asset: data || asset });
});

// DELETE /api/media/:id — administrators only
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { asset, migration } = await findAsset(req.params.id);
  if (migration) return res.status(409).json(MIGRATION_MSG);
  if (!asset) return res.status(404).json({ error: 'File not found.' });
  const { error: storageError } = await supabase.storage.from(asset.bucket).remove([asset.storage_path]);
  if (storageError) return res.status(500).json({ error: 'Could not delete the stored file.' });
  await supabase.from('media_assets').delete().eq('id', asset.id);
  logActivity(req.session.user, 'media_deleted', `Deleted file "${asset.file_name}"`);
  res.json({ success: true });
});

module.exports = router;
