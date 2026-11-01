// server/routes/company.js
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth, requireRole } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString, sanitizeUrl } = require('../middleware/security');
const { writeWithOptionalColumns } = require('../dbCompat');

const URL_FIELDS = ['cac_document_url', 'ceo_photo_url', 'logo_url', 'instagram_url', 'tiktok_url', 'youtube_url'];

// GET /api/company — public
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('company_settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: 'Failed to load company info.' });
  res.set('Cache-Control', 'no-cache');
  res.json({ company: data });
});

// PUT /api/company — admin only
router.put('/', requireAuth, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const editable = [
    'company_name', 'description', 'mission', 'vision', 'address', 'cac_number',
    'cac_document_url', 'ceo_name', 'ceo_title', 'ceo_bio', 'ceo_photo_url', 'logo_url',
    'email', 'whatsapp', 'phone', 'instagram_url', 'tiktok_url', 'youtube_url', 'core_values'
  ];
  const payload = {};
  for (const f of editable) {
    if (b[f] === undefined) continue;
    if (URL_FIELDS.includes(f)) {
      const raw = sanitizeString(b[f], 1000);
      const url = sanitizeUrl(raw, 1000);
      // Keep the historical PLACEHOLDER_* values usable; reject anything else that isn't a web address
      if (raw && !url && !/^PLACEHOLDER_/.test(raw)) {
        return res.status(400).json({ error: `"${f.replace(/_/g, ' ')}" must be a web address starting with https://` });
      }
      payload[f] = url || raw;
    } else {
      payload[f] = sanitizeString(b[f], 5000);
    }
  }
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email.replace(/^mailto:/i, ''))) {
    return res.status(400).json({ error: 'Please enter a valid company email address.' });
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await writeWithOptionalColumns(
    (p) => supabase.from('company_settings').update(p).eq('id', 1).select().single(), payload, ['core_values']);
  if (error) return res.status(500).json({ error: 'Failed to update company info.' });
  logActivity(req.session.user, 'company_updated', 'Updated company settings');
  res.json({ company: data });
});

module.exports = router;
