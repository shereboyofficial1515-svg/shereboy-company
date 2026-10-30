// server/routes/upload.js
// Handles image/PDF uploads (project images, blog images, logo, CEO photo,
// review photos, company documents) to Supabase Storage. Only the backend
// ever touches the storage bucket directly. Validation lives in uploadStore.js.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { uploadLimiter, sanitizeString } = require('../middleware/security');
const { receiveFile, storeFile, registerAsset, safeDisplayName } = require('../uploadStore');

router.post('/', requireAuth, uploadLimiter, async (req, res) => {
  const file = await receiveFile(req, res);
  if (!file) return; // response already sent

  const isPrivate = req.body.private === 'true';
  const stored = await storeFile(file, { folder: req.body.folder, isPrivate });
  if (stored.error) return res.status(500).json({ error: stored.error });

  const asset = await registerAsset({
    bucket: stored.bucket,
    storage_path: stored.path,
    url: stored.url,
    file_name: safeDisplayName(file.originalname),
    mime_type: file.mimetype,
    size_bytes: file.size,
    folder: stored.path.split('/')[0],
    description: sanitizeString(req.body.description, 300) || null,
    is_private: isPrivate,
    uploaded_by: req.session.user.username
  });

  logActivity(req.session.user, 'file_uploaded', `Uploaded ${isPrivate ? 'private ' : ''}file "${safeDisplayName(file.originalname)}"`);
  res.json({ url: stored.url, path: stored.path, private: isPrivate, asset });
});

module.exports = router;
