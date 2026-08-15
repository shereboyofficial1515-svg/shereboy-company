// server/routes/projects.js
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString } = require('../middleware/security');
const { notifyNewProject } = require('../email');

// GET /api/projects — public, published only, supports pagination
router.get('/', async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 12, 50);
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('projects')
    .select('*', { count: 'exact' })
    .eq('published', true)
    .order('featured', { ascending: false })
    .order('completion_date', { ascending: false })
    .range(from, to);

  if (req.query.category) query = query.eq('category', req.query.category);
  if (req.query.featured === 'true') query = query.eq('featured', true);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: 'Failed to load projects.' });
  res.json({ projects: data, total: count, page, limit });
});

// GET /api/projects/admin/all — admin only, includes unpublished
// (declared before /:id so it isn't shadowed by the dynamic param route)
router.get('/admin/all', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to load projects.' });
  res.json({ projects: data });
});

// GET /api/projects/:id — public, must be published
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', req.params.id)
    .eq('published', true)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Project not found.' });
  res.json({ project: data });
});

// POST /api/projects — admin only
router.post('/', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'Title is required.' });

  const payload = {
    title: sanitizeString(b.title, 200),
    description: sanitizeString(b.description, 3000),
    category: sanitizeString(b.category, 100),
    image_url: sanitizeString(b.image_url, 1000),
    technologies: Array.isArray(b.technologies) ? b.technologies.map(t => sanitizeString(t, 50)) : [],
    client_name: sanitizeString(b.client_name, 150),
    completion_date: b.completion_date || null,
    status: sanitizeString(b.status, 30) || 'completed',
    live_url: sanitizeString(b.live_url, 1000),
    github_url: sanitizeString(b.github_url, 1000),
    featured: !!b.featured,
    published: b.published !== undefined ? !!b.published : true
  };

  const { data, error } = await supabase.from('projects').insert(payload).select().single();
  if (error) return res.status(500).json({ error: 'Failed to create project.' });
  logActivity(req.session.user.id, 'project_created', `Created project "${payload.title}"`);
  notifyNewProject(payload).catch(() => { });
  res.status(201).json({ project: data });
});

// PUT /api/projects/:id — admin only
router.put('/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const payload = {};
  const fields = ['title', 'description', 'category', 'image_url', 'client_name', 'status', 'live_url', 'github_url'];
  fields.forEach(f => { if (b[f] !== undefined) payload[f] = sanitizeString(b[f], 3000); });
  if (b.technologies !== undefined) payload.technologies = Array.isArray(b.technologies) ? b.technologies.map(t => sanitizeString(t, 50)) : [];
  if (b.completion_date !== undefined) payload.completion_date = b.completion_date || null;
  if (b.featured !== undefined) payload.featured = !!b.featured;
  if (b.published !== undefined) payload.published = !!b.published;
  payload.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('projects').update(payload).eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Project not found or update failed.' });
  logActivity(req.session.user.id, 'project_edited', `Edited project "${data.title}"`);
  res.json({ project: data });
});

// DELETE /api/projects/:id — admin only
router.delete('/:id', requireAuth, async (req, res) => {
  const { data } = await supabase.from('projects').select('title').eq('id', req.params.id).single();
  const { error } = await supabase.from('projects').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Failed to delete project.' });
  logActivity(req.session.user.id, 'project_deleted', `Deleted project "${data?.title || req.params.id}"`);
  res.json({ success: true });
});

module.exports = router;