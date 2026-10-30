// server/routes/projects.js
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString, sanitizeUrl, previewCheckLimiter } = require('../middleware/security');
const { notifyNewProject } = require('../email');
const { writeWithOptionalColumns, queryWithFallback, isMissingColumnError } = require('../dbCompat');
const { checkEmbeddable, clearPreviewCache } = require('../previewCheck');

const STATUSES = ['completed', 'in_progress', 'maintenance'];
// Added by the 2026-10-29 migration — stripped automatically if not yet run
const OPTIONAL_COLUMNS = ['preview_enabled', 'display_order'];

function toTechList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list.map(t => sanitizeString(String(t), 50)).filter(Boolean).slice(0, 20);
}

function buildPayload(b, { partial }) {
  const payload = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('title')) payload.title = sanitizeString(b.title, 200);
  if (has('description')) payload.description = sanitizeString(b.description, 5000);
  if (has('category')) payload.category = sanitizeString(b.category, 100);
  if (has('image_url')) payload.image_url = sanitizeUrl(b.image_url, 1000);
  if (has('technologies')) payload.technologies = toTechList(b.technologies);
  if (has('client_name')) payload.client_name = sanitizeString(b.client_name, 150);
  if (has('completion_date')) payload.completion_date = /^\d{4}-\d{2}-\d{2}$/.test(b.completion_date || '') ? b.completion_date : null;
  if (has('status')) payload.status = STATUSES.includes(b.status) ? b.status : 'completed';
  if (has('live_url')) payload.live_url = sanitizeUrl(b.live_url, 1000);
  if (has('github_url')) payload.github_url = sanitizeUrl(b.github_url, 1000);
  if (b.featured !== undefined || !partial) payload.featured = !!b.featured;
  if (b.published !== undefined || !partial) payload.published = b.published !== undefined ? !!b.published : true;
  if (b.preview_enabled !== undefined || !partial) payload.preview_enabled = b.preview_enabled !== undefined ? !!b.preview_enabled : true;
  if (b.display_order !== undefined) payload.display_order = Math.max(0, Math.min(parseInt(b.display_order, 10) || 0, 100000));
  return payload;
}

// GET /api/projects — public, published only, supports pagination
router.get('/', async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 12, 50);
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await queryWithFallback((useOptional) => {
    let query = supabase.from('projects').select('*', { count: 'exact' }).eq('published', true);
    if (useOptional) query = query.order('display_order', { ascending: true });
    query = query
      .order('featured', { ascending: false })
      .order('completion_date', { ascending: false, nullsFirst: false })
      .range(from, to);
    if (req.query.category) query = query.eq('category', String(req.query.category).slice(0, 100));
    if (req.query.featured === 'true') query = query.eq('featured', true);
    return query;
  });
  if (error) return res.status(500).json({ error: 'Failed to load projects.' });
  res.json({ projects: data, total: count, page, limit });
});

// GET /api/projects/admin/all — admin only, includes unpublished
// (declared before /:id so it isn't shadowed by the dynamic param route)
router.get('/admin/all', requireAuth, async (req, res) => {
  const { data, error } = await queryWithFallback((useOptional) => {
    let query = supabase.from('projects').select('*');
    if (useOptional) query = query.order('display_order', { ascending: true });
    return query.order('created_at', { ascending: false });
  });
  if (error) return res.status(500).json({ error: 'Failed to load projects.' });
  const migrated = !data.length || Object.prototype.hasOwnProperty.call(data[0], 'display_order');
  res.json({ projects: data, migrated });
});

// PUT /api/projects/admin/reorder — admin only. Body: { ids: [uuid, ...] } in display order
router.put('/admin/reorder', requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => typeof id === 'string').slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ error: 'No projects to reorder.' });
  for (let i = 0; i < ids.length; i += 1) {
    const { error } = await supabase.from('projects').update({ display_order: (i + 1) * 10 }).eq('id', ids[i]);
    if (error) {
      if (isMissingColumnError(error)) {
        return res.status(409).json({ error: 'Project ordering needs the latest database update. Run database/migrations/2026-10-29-portfolio-media-admin.sql in Supabase.', code: 'MIGRATION_REQUIRED' });
      }
      return res.status(500).json({ error: 'Failed to save the new order.' });
    }
  }
  logActivity(req.session.user, 'projects_reordered', `Reordered ${ids.length} projects`);
  res.json({ success: true });
});

// GET /api/projects/admin/:id/preview-check — admin only, any project
router.get('/admin/:id/preview-check', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('projects').select('live_url').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Project not found.' });
  if (req.query.fresh === '1') clearPreviewCache(data.live_url);
  res.json(await checkEmbeddable(data.live_url));
});

// GET /api/projects/:id/preview-check — public, published projects only
router.get('/:id/preview-check', previewCheckLimiter, async (req, res) => {
  const { data, error } = await supabase.from('projects').select('*').eq('id', req.params.id).eq('published', true).single();
  if (error || !data) return res.status(404).json({ error: 'Project not found.' });
  if (data.preview_enabled === false) return res.json({ embeddable: false, disabled: true, reason: 'Live preview is turned off for this project.' });
  const result = await checkEmbeddable(data.live_url);
  // Only cache conclusive answers; "unknown" (site waking up) must be re-checkable
  res.set('Cache-Control', result.embeddable === null ? 'no-store' : 'public, max-age=300');
  res.json(result);
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
  const payload = buildPayload(b, { partial: false });
  if (!payload.title) return res.status(400).json({ error: 'Project name is required.' });
  if (b.live_url && !payload.live_url) return res.status(400).json({ error: 'The live website address must start with https:// or http://' });

  const { data, error } = await writeWithOptionalColumns(
    (p) => supabase.from('projects').insert(p).select().single(), payload, OPTIONAL_COLUMNS);
  if (error) return res.status(500).json({ error: 'Failed to create project.' });
  logActivity(req.session.user, 'project_created', `Created project "${payload.title}"`);
  notifyNewProject(payload).catch(() => { });
  res.status(201).json({ project: data });
});

// PUT /api/projects/:id — admin only
router.put('/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const payload = buildPayload(b, { partial: true });
  if (payload.title !== undefined && !payload.title) return res.status(400).json({ error: 'Project name is required.' });
  if (b.live_url && !payload.live_url) return res.status(400).json({ error: 'The live website address must start with https:// or http://' });
  payload.updated_at = new Date().toISOString();

  const { data, error } = await writeWithOptionalColumns(
    (p) => supabase.from('projects').update(p).eq('id', req.params.id).select().single(), payload, OPTIONAL_COLUMNS);
  if (error || !data) return res.status(404).json({ error: 'Project not found or update failed.' });
  if (payload.live_url !== undefined) clearPreviewCache(data.live_url);
  logActivity(req.session.user, 'project_edited', `Edited project "${data.title}"`);
  res.json({ project: data });
});

// DELETE /api/projects/:id — admin only
router.delete('/:id', requireAuth, async (req, res) => {
  const { data } = await supabase.from('projects').select('title').eq('id', req.params.id).single();
  const { error } = await supabase.from('projects').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Failed to delete project.' });
  logActivity(req.session.user, 'project_deleted', `Deleted project "${data?.title || req.params.id}"`);
  res.json({ success: true });
});

module.exports = router;
