// server/routes/company.js
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString } = require('../middleware/security');

// GET /api/company — public
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('company_settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: 'Failed to load company info.' });
  res.json({ company: data });
});

// PUT /api/company — admin only
router.put('/', requireAuth, async (req, res) => {
  const b = req.body || {};
  const editable = [
    'company_name', 'description', 'mission', 'vision', 'address', 'cac_number',
    'cac_document_url', 'ceo_name', 'ceo_title', 'ceo_bio', 'ceo_photo_url', 'logo_url',
    'email', 'whatsapp', 'phone', 'instagram_url', 'tiktok_url', 'youtube_url'
  ];
  const payload = {};
  editable.forEach(f => { if (b[f] !== undefined) payload[f] = sanitizeString(b[f], 5000); });
  payload.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('company_settings').update(payload).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: 'Failed to update company info.' });
  logActivity(req.session.user.id, 'company_updated', 'Updated company settings');
  res.json({ company: data });
});

module.exports = router;
