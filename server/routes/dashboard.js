// server/routes/dashboard.js
// Every number returned here is counted from the real database — nothing is
// estimated or invented. Optional series (charts) are only returned when data exists.
const express = require('express');
const router = express.Router();
const supabase = require('../database');
const { requireAuth } = require('../auth');

const COMPANY_CONTENT_FIELDS = [
  ['description', 'Company introduction'],
  ['mission', 'Mission'],
  ['vision', 'Vision'],
  ['ceo_bio', 'Founder biography'],
  ['ceo_photo_url', 'Founder photograph'],
  ['logo_url', 'Company logo'],
  ['cac_number', 'CAC registration number'],
  ['cac_document_url', 'CAC certificate'],
  ['address', 'Office address'],
  ['email', 'Contact email'],
  ['phone', 'Phone number'],
  ['whatsapp', 'WhatsApp number']
];

function isFilled(v) {
  return typeof v === 'string' ? !!v.trim() && !/^PLACEHOLDER_|^\[.*\]$/.test(v.trim()) : !!v;
}

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5, 1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const [projects, posts, reviews, messages, unreadMessages, services, company, recentMessages, activity] = await Promise.all([
      supabase.from('projects').select('published, featured, status, category, live_url, image_url'),
      supabase.from('blog_posts').select('published'),
      supabase.from('reviews').select('published'),
      supabase.from('contact_messages').select('id', { count: 'exact', head: true }),
      supabase.from('contact_messages').select('id', { count: 'exact', head: true }).eq('read', false),
      supabase.from('services').select('published'),
      supabase.from('company_settings').select('*').eq('id', 1).single(),
      supabase.from('contact_messages').select('created_at').gte('created_at', sixMonthsAgo.toISOString()),
      supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(10)
    ]);

    const projectRows = projects.data || [];
    const byStatus = {};
    const byCategory = {};
    projectRows.forEach(p => {
      byStatus[p.status || 'completed'] = (byStatus[p.status || 'completed'] || 0) + 1;
      const cat = (p.category || 'Uncategorised').trim();
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    });

    // Enquiries per month for the last 6 calendar months (zero-filled)
    const months = [];
    for (let i = 0; i < 6; i += 1) {
      const d = new Date(sixMonthsAgo);
      d.setMonth(sixMonthsAgo.getMonth() + i);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en-GB', { month: 'short' }), count: 0 });
    }
    (recentMessages.data || []).forEach(m => {
      const key = String(m.created_at).slice(0, 7);
      const month = months.find(x => x.key === key);
      if (month) month.count += 1;
    });

    const c = company.data || {};
    const contentStatus = COMPANY_CONTENT_FIELDS.map(([field, label]) => ({ field, label, complete: isFilled(c[field]) }));

    const count = (rows, pred) => (rows || []).filter(pred).length;
    res.json({
      totalProjects: projectRows.length,
      publishedProjects: count(projectRows, p => p.published),
      draftProjects: count(projectRows, p => !p.published),
      featuredProjects: count(projectRows, p => p.featured),
      projectsWithLiveSite: count(projectRows, p => !!p.live_url),
      projectsMissingImage: count(projectRows, p => !p.image_url),
      projectsByStatus: byStatus,
      projectsByCategory: byCategory,
      totalPosts: (posts.data || []).length,
      publishedPosts: count(posts.data, p => p.published),
      totalReviews: (reviews.data || []).length,
      publishedReviews: count(reviews.data, r => r.published),
      totalServices: (services.data || []).length,
      publishedServices: count(services.data, s => s.published),
      totalMessages: messages.count || 0,
      unreadMessages: unreadMessages.count || 0,
      enquiriesByMonth: months.map(({ label, count: n }) => ({ label, count: n })),
      contentStatus,
      recentActivity: activity.data || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load dashboard stats.' });
  }
});

module.exports = router;
