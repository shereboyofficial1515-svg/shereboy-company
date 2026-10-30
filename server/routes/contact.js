// server/routes/contact.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const supabase = require('../database');
const { requireAuth } = require('../auth');
const { logActivity } = require('../activityLog');
const { sanitizeString } = require('../middleware/security');
const { notifyNewContactMessage } = require('../email');

// Stricter limiter just for this public-facing form — prevents spam/abuse
const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many messages sent. Please try again later.' }
});

// Must match the options in the public enquiry form
const PROJECT_TYPES = [
    'Website', 'Web application', 'Custom software', 'Business management system',
    'Mobile application', 'API / integration', 'Maintenance & support', 'Something else'
];

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// POST /api/contact — public
router.post('/', contactLimiter, async (req, res) => {
    const b = req.body || {};
    const name = sanitizeString(b.name, 150);
    const email = sanitizeString(b.email, 200);
    const phone = sanitizeString(b.phone, 50);
    const message = sanitizeString(b.message, 3000);
    // The enquiry form sends a project type; it is stored in the existing `subject` column
    const projectType = PROJECT_TYPES.includes(b.project_type) ? b.project_type : '';
    const subject = projectType ? `Project enquiry: ${projectType}` : sanitizeString(b.subject, 200);

    // Honeypot field — real visitors never see or fill it
    if (b.website) {
        return res.status(201).json({ success: true, message: "Thank you — your enquiry has been received." });
    }
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'Name, email, and project description are required.' });
    }
    if (name.length < 2) {
        return res.status(400).json({ error: 'Please enter your full name.' });
    }
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (phone && !/^[+()\d\s-]{7,20}$/.test(phone)) {
        return res.status(400).json({ error: 'Please enter a valid phone number (digits, spaces, + and - only).' });
    }
    if (message.length < 10) {
        return res.status(400).json({ error: 'Please tell us a little more about your project (at least 10 characters).' });
    }

    const payload = { name, email, phone, subject, message };

    const { error } = await supabase.from('contact_messages').insert(payload);
    if (error) return res.status(500).json({ error: 'We could not send your enquiry. Please try again, or contact us by email or WhatsApp.' });

    notifyNewContactMessage(payload).catch(() => { });
    res.status(201).json({ success: true, message: "Thank you — your enquiry has been received. We'll get back to you within one business day." });
});

// GET /api/contact/admin/all — admin only
router.get('/admin/all', requireAuth, async (req, res) => {
    const { data, error } = await supabase.from('contact_messages').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load messages.' });
    res.json({ messages: data });
});

// PUT /api/contact/:id/read — admin only, toggle read status
router.put('/:id/read', requireAuth, async (req, res) => {
    const read = req.body?.read !== undefined ? !!req.body.read : true;
    const { data, error } = await supabase.from('contact_messages').update({ read }).eq('id', req.params.id).select().single();
    if (error || !data) return res.status(404).json({ error: 'Message not found.' });
    res.json({ message: data });
});

// DELETE /api/contact/:id — admin only
router.delete('/:id', requireAuth, async (req, res) => {
    const { data } = await supabase.from('contact_messages').select('name').eq('id', req.params.id).single();
    const { error } = await supabase.from('contact_messages').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete message.' });
    logActivity(req.session.user, 'contact_deleted', `Deleted message from "${data?.name || req.params.id}"`);
    res.json({ success: true });
});

module.exports = router;