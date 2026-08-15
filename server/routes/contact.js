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

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// POST /api/contact — public
router.post('/', contactLimiter, async (req, res) => {
    const b = req.body || {};
    const name = sanitizeString(b.name, 150);
    const email = sanitizeString(b.email, 200);
    const phone = sanitizeString(b.phone, 50);
    const subject = sanitizeString(b.subject, 200);
    const message = sanitizeString(b.message, 3000);

    if (!name || !email || !message) {
        return res.status(400).json({ error: 'Name, email, and message are required.' });
    }
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const payload = { name, email, phone, subject, message };

    const { data, error } = await supabase.from('contact_messages').insert(payload).select().single();
    if (error) return res.status(500).json({ error: 'Failed to send message. Please try again.' });

    notifyNewContactMessage(payload).catch(() => { });
    res.status(201).json({ success: true, message: "Thanks — we'll get back to you soon." });
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
    logActivity(req.session.user.id, 'contact_deleted', `Deleted message from "${data?.name || req.params.id}"`);
    res.json({ success: true });
});

module.exports = router;