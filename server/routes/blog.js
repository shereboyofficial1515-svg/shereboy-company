// server/routes/blog.js
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString } = require('../middleware/security');
const { notifyNewBlogPost } = require('../email');

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

async function uniqueSlug(base) {
  let slug = slugify(base) || 'post';
  let attempt = slug;
  let i = 1;
  while (true) {
    const { data } = await supabase.from('blog_posts').select('id').eq('slug', attempt).maybeSingle();
    if (!data) return attempt;
    i += 1;
    attempt = `${slug}-${i}`;
  }
}

// GET /api/blog — public, published only, supports search + category + pagination
router.get('/', async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 9, 30);
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('blog_posts')
    .select('id, title, slug, excerpt, featured_image_url, author, featured, category_id, created_at', { count: 'exact' })
    .eq('published', true)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (req.query.category) query = query.eq('category_id', req.query.category);
  if (req.query.search) query = query.ilike('title', `%${req.query.search}%`);
  if (req.query.featured === 'true') query = query.eq('featured', true);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: 'Failed to load blog posts.' });
  res.json({ posts: data, total: count, page, limit });
});

// GET /api/blog/categories — public
router.get('/categories', async (req, res) => {
  const { data, error } = await supabase.from('categories').select('*').order('name');
  if (error) return res.status(500).json({ error: 'Failed to load categories.' });
  res.json({ categories: data });
});

// GET /api/blog/admin/all — admin only, includes drafts
router.get('/admin/all', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('blog_posts').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to load posts.' });
  res.json({ posts: data });
});

// GET /api/blog/:slug — public, published only
router.get('/:slug', async (req, res) => {
  const { data, error } = await supabase.from('blog_posts').select('*').eq('slug', req.params.slug).eq('published', true).single();
  if (error || !data) return res.status(404).json({ error: 'Post not found.' });
  res.json({ post: data });
});

// POST /api/blog — admin only
router.post('/', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.content) return res.status(400).json({ error: 'Title and content are required.' });

  const slug = b.slug ? slugify(b.slug) : await uniqueSlug(b.title);

  const payload = {
    title: sanitizeString(b.title, 200),
    slug,
    excerpt: sanitizeString(b.excerpt, 500),
    content: b.content, // long-form HTML/markdown — not truncated
    featured_image_url: sanitizeString(b.featured_image_url, 1000),
    category_id: b.category_id || null,
    author: sanitizeString(b.author, 100) || 'SHEREBOY TECH LTD',
    featured: !!b.featured,
    published: b.published !== undefined ? !!b.published : false
  };

  const { data, error } = await supabase.from('blog_posts').insert(payload).select().single();
  if (error) return res.status(500).json({ error: 'Failed to create post.' });
  logActivity(req.session.user.id, 'blog_created', `Created blog post "${payload.title}"`);
  notifyNewBlogPost(payload).catch(() => { });
  res.status(201).json({ post: data });
});

// PUT /api/blog/:id — admin only
router.put('/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const payload = {};
  if (b.title !== undefined) payload.title = sanitizeString(b.title, 200);
  if (b.slug !== undefined) payload.slug = slugify(b.slug);
  if (b.excerpt !== undefined) payload.excerpt = sanitizeString(b.excerpt, 500);
  if (b.content !== undefined) payload.content = b.content;
  if (b.featured_image_url !== undefined) payload.featured_image_url = sanitizeString(b.featured_image_url, 1000);
  if (b.category_id !== undefined) payload.category_id = b.category_id || null;
  if (b.author !== undefined) payload.author = sanitizeString(b.author, 100);
  if (b.featured !== undefined) payload.featured = !!b.featured;
  if (b.published !== undefined) payload.published = !!b.published;
  payload.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('blog_posts').update(payload).eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Post not found or update failed.' });
  logActivity(req.session.user.id, 'blog_edited', `Edited blog post "${data.title}"`);
  res.json({ post: data });
});

// DELETE /api/blog/:id — admin only
router.delete('/:id', requireAuth, async (req, res) => {
  const { data } = await supabase.from('blog_posts').select('title').eq('id', req.params.id).single();
  const { error } = await supabase.from('blog_posts').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Failed to delete post.' });
  logActivity(req.session.user.id, 'blog_deleted', `Deleted blog post "${data?.title || req.params.id}"`);
  res.json({ success: true });
});

module.exports = router;