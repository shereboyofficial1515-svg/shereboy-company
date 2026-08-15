// server/routes/dashboard.js
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth } = require('../auth');

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const [projects, pubProjects, posts, pubPosts, reviews, pubReviews, messages, unreadMessages, activity] = await Promise.all([
      supabase.from('projects').select('id', { count: 'exact', head: true }),
      supabase.from('projects').select('id', { count: 'exact', head: true }).eq('published', true),
      supabase.from('blog_posts').select('id', { count: 'exact', head: true }),
      supabase.from('blog_posts').select('id', { count: 'exact', head: true }).eq('published', true),
      supabase.from('reviews').select('id', { count: 'exact', head: true }),
      supabase.from('reviews').select('id', { count: 'exact', head: true }).eq('published', true),
      supabase.from('contact_messages').select('id', { count: 'exact', head: true }),
      supabase.from('contact_messages').select('id', { count: 'exact', head: true }).eq('read', false),
      supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(10)
    ]);

    res.json({
      totalProjects: projects.count || 0,
      publishedProjects: pubProjects.count || 0,
      totalPosts: posts.count || 0,
      publishedPosts: pubPosts.count || 0,
      totalReviews: reviews.count || 0,
      publishedReviews: pubReviews.count || 0,
      totalMessages: messages.count || 0,
      unreadMessages: unreadMessages.count || 0,
      recentActivity: activity.data || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load dashboard stats.' });
  }
});

module.exports = router;