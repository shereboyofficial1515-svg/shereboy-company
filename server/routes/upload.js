// server/routes/upload.js
// Handles image uploads (project images, blog images, logo, CEO photo, review photos)
// to Supabase Storage. Only the backend ever touches the storage bucket directly.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const supabase = require('../database');
const { requireAuth } = require('../auth');

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'sheroboytech-media';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('Unsupported file type. Only JPEG, PNG, WEBP and GIF are allowed.'));
    }
    cb(null, true);
  }
});

router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });

    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const safeName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const folder = ['projects', 'blog', 'reviews', 'company'].includes(req.body.folder) ? req.body.folder : 'misc';
    const path = `${folder}/${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (uploadError) {
      return res.status(500).json({ error: 'Upload failed. Make sure the storage bucket exists (see README).' });
    }

    const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
    res.json({ url: publicUrlData.publicUrl, path });
  });
});

module.exports = router;
