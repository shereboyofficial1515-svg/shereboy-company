// server/routes/services.js
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString } = require('../middleware/security');
const { writeWithOptionalColumns } = require('../dbCompat');

// One benefit per line (or array item); `benefits` only exists after the 2026-10-29 migration
function toBenefits(value) {
  const list = Array.isArray(value) ? value : String(value || '').split('\n');
  return list.map(v => sanitizeString(String(v), 160)).filter(Boolean).slice(0, 8);
}

// GET /api/services — public, published only
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('services').select('*').eq('published', true).order('display_order', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to load services.' });
  res.json({ services: data });
});

// GET /api/services/admin/all — admin only
router.get('/admin/all', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('services').select('*').order('display_order', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to load services.' });
  res.json({ services: data });
});

// POST /api/services — admin only
router.post('/', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!sanitizeString(b.title, 150)) return res.status(400).json({ error: 'Title is required.' });
  const payload = {
    title: sanitizeString(b.title, 150),
    description: sanitizeString(b.description, 1000),
    icon: sanitizeString(b.icon, 100),
    display_order: parseInt(b.display_order) || 0,
    published: b.published !== undefined ? !!b.published : true,
    benefits: toBenefits(b.benefits)
  };
  const { data, error } = await writeWithOptionalColumns(
    (p) => supabase.from('services').insert(p).select().single(), payload, ['benefits']);
  if (error) return res.status(500).json({ error: 'Failed to create service.' });
  logActivity(req.session.user, 'service_created', `Created service "${payload.title}"`);
  res.status(201).json({ service: data });
});

// PUT /api/services/:id — admin only
router.put('/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const payload = {};
  if (b.title !== undefined) payload.title = sanitizeString(b.title, 150);
  if (b.description !== undefined) payload.description = sanitizeString(b.description, 1000);
  if (b.icon !== undefined) payload.icon = sanitizeString(b.icon, 100);
  if (b.display_order !== undefined) payload.display_order = parseInt(b.display_order) || 0;
  if (b.published !== undefined) payload.published = !!b.published;
  if (b.benefits !== undefined) payload.benefits = toBenefits(b.benefits);
  payload.updated_at = new Date().toISOString();

  const { data, error } = await writeWithOptionalColumns(
    (p) => supabase.from('services').update(p).eq('id', req.params.id).select().single(), payload, ['benefits']);
  if (error || !data) return res.status(404).json({ error: 'Service not found or update failed.' });
  logActivity(req.session.user, 'service_edited', `Edited service "${data.title}"`);
  res.json({ service: data });
});

// DELETE /api/services/:id — admin only
router.delete('/:id', requireAuth, async (req, res) => {
  const { data } = await supabase.from('services').select('title').eq('id', req.params.id).single();
  const { error } = await supabase.from('services').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Failed to delete service.' });
  logActivity(req.session.user, 'service_deleted', `Deleted service "${data?.title || req.params.id}"`);
  res.json({ success: true });
});

module.exports = router;
