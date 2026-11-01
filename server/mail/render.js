// server/mail/render.js
// Turns editor content into email HTML. Everything an administrator writes,
// including source mode, passes through the same sanitizer before it is stored
// or sent. Email clients need tables and inline styles, so those are added here.
const sanitizeHtml = require('sanitize-html');

const COLORS = { text: '#1f2937', muted: '#6b7280', line: '#e5e7eb', bg: '#f3f4f6', card: '#ffffff', accent: '#2563eb', navy: '#0d1526' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SANITIZE = {
  allowedTags: ['h1', 'h2', 'h3', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li', 'img', 'hr', 'blockquote', 'div', 'span'],
  allowedAttributes: {
    a: ['href', 'title', 'class'],
    img: ['src', 'alt', 'width', 'height'],
    p: ['style'], h1: ['style'], h2: ['style'], h3: ['style'], div: ['style']
  },
  allowedClasses: { a: ['email-btn'] },
  allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/] } },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed']
};

const sanitizeEmailHtml = (html) => sanitizeHtml(String(html || ''), SANITIZE).trim();

const TAG_STYLES = {
  h1: `margin:0 0 16px;font-size:26px;line-height:1.25;font-weight:700;color:${COLORS.text};`,
  h2: `margin:24px 0 12px;font-size:21px;line-height:1.3;font-weight:700;color:${COLORS.text};`,
  h3: `margin:20px 0 10px;font-size:17px;line-height:1.35;font-weight:700;color:${COLORS.text};`,
  p: `margin:0 0 16px;font-size:16px;line-height:1.6;color:${COLORS.text};`,
  ul: `margin:0 0 16px;padding-left:22px;font-size:16px;line-height:1.6;color:${COLORS.text};`,
  ol: `margin:0 0 16px;padding-left:22px;font-size:16px;line-height:1.6;color:${COLORS.text};`,
  li: 'margin:0 0 6px;',
  blockquote: `margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid ${COLORS.line};color:${COLORS.muted};`,
  hr: `border:0;border-top:1px solid ${COLORS.line};margin:24px 0;`,
  img: 'display:block;max-width:100%;height:auto;border:0;margin:0 0 16px;border-radius:6px;',
  a: `color:${COLORS.accent};text-decoration:underline;`
};

// A table cell keeps the button's colour in Outlook, which ignores most link styling
const ctaButton = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;"><tr><td bgcolor="${COLORS.accent}" style="background:${COLORS.accent};border-radius:6px;"><a href="${href}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${label}</a></td></tr></table>`;

function inlineStyles(cleanHtml) {
  const transformTags = {};
  Object.entries(TAG_STYLES).forEach(([tag, style]) => {
    transformTags[tag] = (tagName, attribs) => ({ tagName, attribs: { ...attribs, style: `${style}${attribs.style ? attribs.style : ''}` } });
  });
  transformTags.a = (tagName, attribs) => {
    if (attribs.class === 'email-btn') return { tagName, attribs: { href: attribs.href || '#', 'data-cta': '1' } };
    return { tagName, attribs: { ...attribs, style: TAG_STYLES.a } };
  };
  // cleanHtml has already passed the strict sanitizer; this pass only adds styles
  const styled = sanitizeHtml(cleanHtml, { allowedTags: false, allowedAttributes: false, allowVulnerableTags: true, allowedSchemes: SANITIZE.allowedSchemes, allowedSchemesByTag: SANITIZE.allowedSchemesByTag, transformTags });
  const cta = /<a [^>]*data-cta="1"[^>]*>[\s\S]*?<\/a>/g;
  const build = (m) => {
    const href = (/href="([^"]*)"/.exec(m) || [])[1] || '#';
    const label = m.replace(/^<a [^>]*>/, '').replace(/<\/a>$/, '');
    return ctaButton(href, label);
  };
  return styled
    .replace(new RegExp(`<p[^>]*>\\s*(${cta.source})\\s*</p>`, 'g'), (m, a) => build(a))
    .replace(cta, build);
}

function personalize(html, { firstName }) {
  return html.replace(/\{\{\s*first_name\s*\}\}/g, esc(firstName || 'there'));
}

/** A mobile-friendly, table-based layout that holds up in Gmail, Outlook and phone apps. */
function renderLayout({ subject, preheader, bodyHtml, settings, unsubscribeUrl, footerNote }) {
  const logo = /^https:\/\//.test(settings.logo_url || '')
    ? `<img src="${esc(settings.logo_url)}" alt="${esc(settings.sender_name)}" height="40" style="display:block;height:40px;width:auto;border:0;">`
    : `<span style="font-family:${FONT};font-size:18px;font-weight:700;letter-spacing:.3px;color:#ffffff;">${esc(settings.sender_name)}</span>`;
  const contact = [settings.contact_address, settings.contact_email, settings.contact_phone].filter(Boolean).map(esc).join(' &middot; ');
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.bg};-webkit-text-size-adjust:100%;">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.bg}" style="background:${COLORS.bg};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td bgcolor="${COLORS.navy}" style="background:${COLORS.navy};padding:20px 28px;border-radius:10px 10px 0 0;">${logo}</td></tr>
<tr><td bgcolor="${COLORS.card}" style="background:${COLORS.card};padding:32px 28px 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${COLORS.text};">${bodyHtml}</td></tr>
<tr><td bgcolor="${COLORS.card}" style="background:${COLORS.card};padding:0 28px 28px;border-radius:0 0 10px 10px;font-family:${FONT};font-size:13px;line-height:1.6;color:${COLORS.muted};">
<div style="border-top:1px solid ${COLORS.line};padding-top:16px;">
${settings.footer_text ? `<div>${esc(settings.footer_text)}</div>` : ''}
${contact ? `<div>${contact}</div>` : ''}
${footerNote ? `<div style="margin-top:8px;">${esc(footerNote)}</div>` : ''}
${unsubscribeUrl ? `<div style="margin-top:8px;"><a href="${esc(unsubscribeUrl)}" style="color:${COLORS.muted};text-decoration:underline;">Unsubscribe</a> from these emails at any time.</div>` : ''}
</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Plain-text version: many inboxes and spam filters look for one. */
function htmlToText(html) {
  const withLinks = String(html).replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (m, href, label) => `${label} (${href})`);
  return sanitizeHtml(withLinks.replace(/<li[^>]*>/g, '- ').replace(/<(\/p|br\s*\/?|\/h[1-3]|\/li|hr[^>]*)>/g, '\n'), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Builds a complete message from stored content. */
function buildMessage({ subject, preheader, bodyHtml, settings, firstName, unsubscribeUrl, footerNote }) {
  const body = personalize(inlineStyles(sanitizeEmailHtml(bodyHtml)), { firstName });
  const html = renderLayout({ subject, preheader, bodyHtml: body, settings, unsubscribeUrl, footerNote });
  const plain = htmlToText(body);
  const text = `${plain}\n\n--\n${settings.footer_text || settings.sender_name}${footerNote ? `\n${footerNote}` : ''}${unsubscribeUrl ? `\nUnsubscribe: ${unsubscribeUrl}` : ''}`;
  return { html, text };
}

// Starting points only: the bracketed text is for the administrator to replace.
const cta = (label) => `<p><a class="email-btn" href="https://shereboytechltd.site">${label}</a></p>`;
const DEFAULT_TEMPLATES = [
  { template_key: 'company-announcement', name: 'Company announcement', category: 'Company', subject: 'An update from SHEREBOY TECH LTD', preheader: '[One line summary shown in the inbox]', body_html: `<h1>[Announcement headline]</h1><p>Hello {{first_name}},</p><p>[Share what has changed and why it matters to the reader.]</p>${cta('Read more')}` },
  { template_key: 'product-launch', name: 'New product launch', category: 'Product', subject: 'Introducing [product name]', preheader: '[What the product does, in one line]', body_html: `<h1>Introducing [product name]</h1><p>Hello {{first_name}},</p><p>[Describe the problem it solves and who it is for.]</p><ul><li>[Key benefit]</li><li>[Key benefit]</li><li>[Key benefit]</li></ul>${cta('See the product')}` },
  { template_key: 'company-update', name: 'SHEREBOY TECH LTD update', category: 'Company', subject: 'What is new at SHEREBOY TECH LTD', preheader: '[This update in one line]', body_html: `<h1>What is new</h1><p>Hello {{first_name}},</p><h2>[First update]</h2><p>[Details.]</p><hr><h2>[Second update]</h2><p>[Details.]</p>${cta('Visit our website')}` },
  { template_key: 'blog-announcement', name: 'SHEREBOY BLOG announcement', category: 'Blog', subject: 'New on SHEREBOY BLOG: [article title]', preheader: '[Why this article is worth reading]', body_html: `<h1>[Article title]</h1><p>Hello {{first_name}},</p><p>[A short summary. Keep the full article on SHEREBOY BLOG.]</p><p><a class="email-btn" href="https://shereblog-news.onrender.com">Read on SHEREBOY BLOG</a></p>` },
  { template_key: 'affiliate-announcement', name: 'SHEREBOY AFFILIATE CONCEPT products', category: 'Affiliate', subject: 'New from SHEREBOY AFFILIATE CONCEPT: [product]', preheader: '[The product in one line]', body_html: `<h1>[Product name]</h1><p>Hello {{first_name}},</p><p>[Describe the product accurately. Say that this is an affiliate product if we may earn a commission.]</p><p><a class="email-btn" href="https://shereboyaffiliateconcept.shop">View product</a></p>` },
  { template_key: 'promotion', name: 'Promotional campaign', category: 'Promotion', subject: '[Offer] from SHEREBOY TECH LTD', preheader: '[The offer and when it ends]', body_html: `<h1>[Offer headline]</h1><p>Hello {{first_name}},</p><p>[Explain the offer, its real terms and when it ends.]</p>${cta('Learn more')}` },
  { template_key: 'welcome', name: 'Welcome email', category: 'Lifecycle', subject: 'Welcome to SHEREBOY TECH LTD updates', preheader: 'Thanks for subscribing', body_html: `<h1>Welcome</h1><p>Hello {{first_name}},</p><p>Thank you for subscribing. We will send you company news, product launches and technology insights.</p>${cta('Visit our website')}` },
  { template_key: 'service-update', name: 'Service update', category: 'Service', subject: 'Service update: [service name]', preheader: '[What is changing and when]', body_html: `<h1>Service update</h1><p>Hello {{first_name}},</p><p><strong>What is changing:</strong> [details]</p><p><strong>When:</strong> [date and time]</p><p><strong>What you need to do:</strong> [action, or "nothing"]</p>${cta('Contact us')}` }
];

module.exports = { sanitizeEmailHtml, inlineStyles, buildMessage, renderLayout, htmlToText, personalize, esc, DEFAULT_TEMPLATES };
