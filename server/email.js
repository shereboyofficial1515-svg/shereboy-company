// server/email.js
// Sends transactional notification emails via Resend.
// Uses RESEND_API_KEY (backend-only, never exposed to the browser) and
// delivers to NOTIFY_EMAIL — your inbox for admin notifications.
//
// If RESEND_API_KEY isn't set, this quietly no-ops instead of crashing —
// so the app keeps working even before you configure email.

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM_ADDRESS = process.env.RESEND_FROM || 'SHEREBOY TECH <onboarding@resend.dev>';

async function sendEmail({ subject, html, to }) {
    const apiKey = process.env.RESEND_API_KEY;
    const notifyTo = to || process.env.NOTIFY_EMAIL;

    if (!apiKey || !notifyTo) {
        console.warn('[email] RESEND_API_KEY or NOTIFY_EMAIL not set — skipping email send.');
        return { skipped: true };
    }

    try {
        const res = await fetch(RESEND_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: FROM_ADDRESS,
                to: [notifyTo],
                subject,
                html
            })
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error('[email] Resend API error:', res.status, errText);
            return { success: false };
        }
        return { success: true };
    } catch (err) {
        console.error('[email] Failed to send email:', err.message);
        return { success: false };
    }
}

// ---- Notification helpers for specific events ----

function notifyNewReview({ client_name, client_position, review_text, rating }) {
    return sendEmail({
        subject: `New review submitted — ${client_name}`,
        html: `
      <h2>New client review submitted</h2>
      <p><strong>Client:</strong> ${escapeHtml(client_name)}${client_position ? ` (${escapeHtml(client_position)})` : ''}</p>
      <p><strong>Rating:</strong> ${'★'.repeat(rating || 5)}</p>
      <p><strong>Review:</strong></p>
      <p>${escapeHtml(review_text)}</p>
      <p>Log in to the admin dashboard to publish or edit it: <a href="/admin">/admin</a></p>
    `
    });
}

function notifyFailedLoginAlert(ip, attemptCount) {
    return sendEmail({
        subject: `Security alert — repeated failed admin logins`,
        html: `
      <h2>Repeated failed login attempts detected</h2>
      <p><strong>IP address:</strong> ${escapeHtml(ip)}</p>
      <p><strong>Attempts:</strong> ${attemptCount}</p>
      <p>If this wasn't you, consider changing your admin password.</p>
    `
    });
}

function notifyNewBlogPost({ title, excerpt, published }) {
    return sendEmail({
        subject: `Blog post ${published ? 'published' : 'saved as draft'} — ${title}`,
        html: `
      <h2>${published ? 'New blog post published' : 'New blog post saved as draft'}</h2>
      <p><strong>Title:</strong> ${escapeHtml(title)}</p>
      ${excerpt ? `<p><strong>Excerpt:</strong> ${escapeHtml(excerpt)}</p>` : ''}
      <p>Manage it in the admin dashboard: <a href="/admin">/admin</a></p>
    `
    });
}

function notifyNewProject({ title, category, client_name, published }) {
    return sendEmail({
        subject: `Project ${published ? 'published' : 'saved as draft'} — ${title}`,
        html: `
      <h2>${published ? 'New project published' : 'New project saved as draft'}</h2>
      <p><strong>Title:</strong> ${escapeHtml(title)}</p>
      ${category ? `<p><strong>Category:</strong> ${escapeHtml(category)}</p>` : ''}
      ${client_name ? `<p><strong>Client:</strong> ${escapeHtml(client_name)}</p>` : ''}
      <p>Manage it in the admin dashboard: <a href="/admin">/admin</a></p>
    `
    });
}

function notifyNewContactMessage({ name, email, phone, subject, message }) {
    return sendEmail({
        subject: `New contact message — ${subject || name}`,
        html: `
      <h2>New message from your website contact form</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      ${phone ? `<p><strong>Phone:</strong> ${escapeHtml(phone)}</p>` : ''}
      ${subject ? `<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>` : ''}
      <p><strong>Message:</strong></p>
      <p>${escapeHtml(message)}</p>
      <p>View and manage messages in the admin dashboard: <a href="/admin">/admin</a></p>
    `
    });
}
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = { sendEmail, notifyNewReview, notifyFailedLoginAlert, notifyNewBlogPost, notifyNewProject, notifyNewContactMessage };