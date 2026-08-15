// server/routes/reviews.js
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString } = require('../middleware/security');
const { notifyNewReview } = require('../email');

// GET /api/reviews — public, published only
router.get('/', async (req, res) => {
  let query = supabase.from('reviews').select('*').eq('published', true).order('featured', { ascending: false }).order('created_at', { ascending: false });
  if (req.query.featured === 'true') query = query.eq('featured', true);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed to load reviews.' });
  res.json({ reviews: data });
});

// GET /api/reviews/admin/all — admin only
router.get('/admin/all', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('reviews').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to load reviews.' });
  res.json({ reviews: data });
});

// POST /api/reviews — admin only
router.post('/', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.client_name || !b.review_text) return res.status(400).json({ error: 'Client name and review text are required.' });

  const payload = {
    client_name: sanitizeString(b.client_name, 150),
    client_position: sanitizeString(b.client_position, 150),
    review_text: sanitizeString(b.review_text, 2000),
    client_image_url: sanitizeString(b.client_image_url, 1000),
    rating: Math.min(Math.max(parseInt(b.rating) || 5, 1), 5),
    featured: !!b.featured,
    published: b.published !== undefined ? !!b.published : false
  };
  const { data, error } = await supabase.from('reviews').insert(payload).select().single();
  if (error) return res.status(500).json({ error: 'Failed to create review.' });
  logActivity(req.session.user.id, 'review_created', `Added review from "${payload.client_name}"`);
  notifyNewReview(payload).catch(() => { });
  res.status(201).json({ review: data });
});

// PUT /api/reviews/:id — admin only
router.put('/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const payload = {};
  if (b.client_name !== undefined) payload.client_name = sanitizeString(b.client_name, 150);
  if (b.client_position !== undefined) payload.client_position = sanitizeString(b.client_position, 150);
  if (b.review_text !== undefined) payload.review_text = sanitizeString(b.review_text, 2000);
  if (b.client_image_url !== undefined) payload.client_image_url = sanitizeString(b.client_image_url, 1000);
  if (b.rating !== undefined) payload.rating = Math.min(Math.max(parseInt(b.rating) || 5, 1), 5);
  if (b.featured !== undefined) payload.featured = !!b.featured;
  if (b.published !== undefined) payload.published = !!b.published;
  payload.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('reviews').update(payload).eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Review not found or update failed.' });
  logActivity(req.session.user.id, 'review_edited', `Edited review from "${data.client_name}"`);
  res.json({ review: data });
});

// DELETE /api/reviews/:id — admin only
router.delete('/:id', requireAuth, async (req, res) => {
  const { data } = await supabase.from('reviews').select('client_name').eq('id', req.params.id).single();
  const { error } = await supabase.from('reviews').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Failed to delete review.' });
  logActivity(req.session.user.id, 'review_deleted', `Deleted review from "${data?.client_name || req.params.id}"`);
  res.json({ success: true });
});

module.exports = router;