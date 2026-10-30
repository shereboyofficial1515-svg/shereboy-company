// server/uploadStore.js
// Shared, defensive file handling for every admin upload (project thumbnails,
// company photos, logo, CAC certificate, media library).
//
//  * Only JPEG / PNG / WEBP / GIF images and PDF documents are accepted.
//  * The declared MIME type must match the file's real signature ("magic
//    bytes") — a renamed .exe or .html is rejected. SVG is deliberately not
//    accepted because it can carry script.
//  * Stored filenames are random; the original name is only kept (sanitized)
//    as a display label.
//  * Private documents go to a separate, non-public bucket and are only ever
//    served to signed-in admins through short-lived signed URLs.

const multer = require('multer');
const crypto = require('crypto');
const supabase = require('./database');
const { isMissingTableError } = require('./dbCompat');

const PUBLIC_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'sheroboytech-media';
const PRIVATE_BUCKET = process.env.SUPABASE_PRIVATE_BUCKET || 'sheroboytech-private';

const TYPES = {
  'image/jpeg': { ext: 'jpg', max: 5 * 1024 * 1024, sig: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', max: 5 * 1024 * 1024, sig: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', max: 5 * 1024 * 1024, sig: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  'image/gif': { ext: 'gif', max: 5 * 1024 * 1024, sig: (b) => /^GIF8[79]a$/.test(b.slice(0, 6).toString('latin1')) },
  'application/pdf': { ext: 'pdf', max: 10 * 1024 * 1024, sig: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' }
};
const MAX_SIZE = Math.max(...Object.values(TYPES).map(t => t.max));
const FOLDERS = ['projects', 'blog', 'reviews', 'company', 'documents', 'media'];

const multerSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (!TYPES[file.mimetype]) {
      return cb(new Error('Unsupported file type. Upload a JPEG, PNG, WEBP or GIF image, or a PDF document.'));
    }
    cb(null, true);
  }
}).single('file');

// Runs multer and turns its errors into friendly 400 responses
function receiveFile(req, res) {
  return new Promise((resolve) => {
    multerSingle(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large. Images can be up to 5MB and PDFs up to 10MB.' : err.message;
        res.status(400).json({ error: msg });
        return resolve(null);
      }
      if (!req.file) {
        res.status(400).json({ error: 'No file provided.' });
        return resolve(null);
      }
      const type = TYPES[req.file.mimetype];
      if (req.file.size > type.max) {
        res.status(400).json({ error: 'That file is too large. Images can be up to 5MB and PDFs up to 10MB.' });
        return resolve(null);
      }
      if (!type.sig(req.file.buffer)) {
        res.status(400).json({ error: 'The file contents do not match its type. Please upload a genuine image or PDF.' });
        return resolve(null);
      }
      resolve(req.file);
    });
  });
}

function safeDisplayName(name) {
  return String(name || 'file')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file';
}

async function storeFile(file, { folder, isPrivate, existingPath, bucket }) {
  const type = TYPES[file.mimetype];
  const targetBucket = bucket || (isPrivate ? PRIVATE_BUCKET : PUBLIC_BUCKET);
  const safeFolder = FOLDERS.includes(folder) ? folder : 'media';
  const path = existingPath || `${safeFolder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${type.ext}`;

  const { error } = await supabase.storage.from(targetBucket).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: !!existingPath,
    cacheControl: '300'
  });
  if (error) {
    const hint = isPrivate
      ? `Make sure a PRIVATE storage bucket named "${targetBucket}" exists in Supabase.`
      : `Make sure the public storage bucket "${targetBucket}" exists in Supabase.`;
    return { error: `Upload failed. ${hint}` };
  }
  const url = isPrivate ? null : supabase.storage.from(targetBucket).getPublicUrl(path).data.publicUrl;
  return { bucket: targetBucket, path, url };
}

// Best-effort registration in the media library table (exists after the 2026-10-29 migration)
async function registerAsset(record) {
  const { data, error } = await supabase.from('media_assets').insert(record).select().single();
  if (error && !isMissingTableError(error)) console.error('[media] could not register asset:', error.message);
  return data || null;
}

module.exports = { TYPES, FOLDERS, PUBLIC_BUCKET, PRIVATE_BUCKET, receiveFile, storeFile, registerAsset, safeDisplayName };
