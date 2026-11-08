// public/admin/feedback.js
// The Reviews & Feedback module of the dashboard. Every number comes from the
// server; the server also decides who may do what.
(function () {
  'use strict';
  const { api, json, esc, toast, confirmDialog, timeAgo, fmtDate, openDialog, closeDialog, isAdmin } = window.AdminKit;
  const root = document.getElementById('feedbackCenter');
  const modal = document.getElementById('emailModal');
  const modalBody = document.getElementById('emailModalBody');
  const modalTitle = document.getElementById('emailModalTitle');
  const q = (s, r = root) => r.querySelector(s);
  const qa = (s, r = root) => Array.from(r.querySelectorAll(s));

  const CATEGORIES = { general: 'General Review', bug: 'Bug Report', feature: 'Feature Request', complaint: 'Complaint', suggestion: 'Suggestion', ux: 'User Experience', other: 'Other' };
  const STATUSES = { new: 'New', under_review: 'Under Review', in_progress: 'In Progress', responded: 'Responded', resolved: 'Resolved', archived: 'Archived' };
  const STATUS_PILL = { new: 'blue', under_review: 'amber', in_progress: 'amber', responded: 'green', resolved: 'green', archived: 'grey', pending: 'amber', approved: 'green', rejected: 'red', unpublished: 'grey' };
  const pill = (s, label) => `<span class="pill pill--${STATUS_PILL[s] || 'grey'}">${esc(label || STATUSES[s] || s)}</span>`;
  const stars = (n) => (Number.isInteger(n) ? `<span class="fb-stars-text" role="img" aria-label="${n} out of 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>` : '<span class="em-muted">No rating</span>');
  const sourceLabel = (s) => (!s || s === 'website' ? 'Website' : `${s.replace(/-app$/, '').replace(/-/g, ' ').toUpperCase()} app`);
  const skeleton = '<div class="card"><span class="skeleton"></span><br><span class="skeleton"></span><br><span class="skeleton"></span></div>';
  const state = { tab: 'overview', filters: { page: 1 }, products: [] };

  function showError(err) {
    root.innerHTML = err.code === 'MIGRATION_REQUIRED'
      ? '<div class="card em-notice"><h2>One step left: update the database</h2><p>Back up your database, then run <code>database/migrations/2026-11-06-reviews-feedback.sql</code> in the Supabase SQL Editor.</p></div>'
      : `<div class="card em-notice"><p>${esc(err.message)}</p><button type="button" class="btn btn--ghost" data-fb-reload>Try again</button></div>`;
  }

  async function loadProducts() {
    const { products } = await api('/api/feedback-admin/products');
    state.products = products;
    return products;
  }

  function setTab(tab) {
    state.tab = ['overview', 'feedback', 'products', 'testimonials', 'analytics'].includes(tab) ? tab : 'overview';
    qa('[data-fb-tab]', document.getElementById('feedbackTabs')).forEach(b => {
      const on = b.dataset.fbTab === state.tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    root.innerHTML = skeleton;
    ({ overview: loadOverview, feedback: loadFeedback, products: renderProducts, testimonials: loadTestimonials, analytics: loadAnalytics })[state.tab]().catch(showError);
  }

  // ---------- Charts (no library: plain HTML and CSS) ----------
  const hbars = (rows, valueText = (r) => r.value) => {
    const max = Math.max(1, ...rows.map(r => r.value || 0));
    return `<div class="fb-hbars">${rows.map(r => `<div class="fb-hbar"><span class="fb-hbar__label" title="${esc(r.label)}">${esc(r.label)}</span><span class="fb-hbar__track"><span class="fb-hbar__fill" style="width:${Math.round((r.value || 0) / max * 100)}%"></span></span><span class="fb-hbar__value">${esc(valueText(r))}</span></div>`).join('')}</div>`;
  };
  const columns = (rows, unit) => {
    const max = Math.max(1, ...rows.map(r => r.value || 0));
    return `<div class="bars" role="img" aria-label="${esc(rows.map(r => `${r.label} ${r.value ?? 'none'}`).join(', '))}">${rows.map(r => `<div class="bar" tabindex="0" style="--h:${Math.round((r.value || 0) / max * 100)}%"><span class="bar__tip">${esc(r.label)}: ${r.value ?? 'none'} ${unit}</span><span class="bar__fill" style="height:var(--h)"></span></div>`).join('')}</div>
      <div class="bar-labels" aria-hidden="true">${rows.map(r => `<span>${esc(r.label)}</span>`).join('')}</div>`;
  };
  const stat = (label, value, hint) => `<div class="em-stat"><span class="em-stat__label">${esc(label)}</span><strong>${value}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
  const card = (title, sub, body) => `<section class="card fb-chart"><header class="card__head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div></header>${body}</section>`;
  const empty = '<p class="empty-chart">No feedback yet.</p>';

  // ---------- Overview ----------
  async function loadOverview() {
    const d = await api('/api/feedback-admin/overview');
    const badge = document.getElementById('feedbackBadge');
    if (badge) { badge.textContent = d.unread; badge.hidden = !d.unread; }
    root.innerHTML = `
      <div class="em-stats">
        ${stat('Total feedback', d.total)}${stat('New', d.new, `${d.unread} unread`)}${stat('Pending', d.pending, 'New, under review or in progress')}${stat('Resolved', d.resolved)}
        ${stat('Average rating', d.avgRating === null ? '—' : `${d.avgRating} / 5`, d.unrated ? `${d.unrated} without a rating (sent from an app)` : '')}${stat('Products with feedback', d.productsWithFeedback)}
      </div>
      <p class="em-muted" data-fb-updated>Updated ${new Date(d.updatedAt).toLocaleTimeString('en-GB')}. New feedback appears automatically.${d.sources.length > 1 ? ` Sources: ${d.sources.map(s => `${sourceLabel(s.source)} ${s.count}`).join(', ')}.` : ''}</p>
      <div class="fb-grid">
        ${card('Feedback received', 'Last 12 months', d.total ? columns(d.months.map(m => ({ label: m.label, value: m.count })), 'received') : empty)}
        ${card('Ratings', 'How many of each star rating', d.total ? hbars(d.ratings.slice().reverse().map(r => ({ label: `${r.rating} star${r.rating > 1 ? 's' : ''}`, value: r.count }))) : empty)}
        ${card('By product', 'Feedback received, with average rating', d.byProduct.length ? hbars(d.byProduct.map(p => ({ label: p.name, value: p.count, avg: p.avgRating })), r => `${r.value}${r.avg ? ` · ${r.avg}★` : ''}`) : '<p class="empty-chart">No products yet.</p>')}
        ${card('By category', '', d.total ? hbars(d.categories.map(c => ({ label: c.label, value: c.count }))) : empty)}
      </div>`;
  }

  // ---------- All feedback ----------
  async function loadFeedback() {
    const products = state.products.length ? state.products : await loadProducts();
    const f = state.filters;
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
    root.innerHTML = `
      <div class="card fb-filters">
        <input class="fb-search" type="search" id="fbQ" placeholder="Search reference, subject, message, name or email" value="${esc(f.q || '')}" aria-label="Search feedback">
        <select id="fbFProduct" aria-label="Product">${opt('', 'All products', f.product)}${products.map(p => opt(p.id, p.name, f.product)).join('')}</select>
        <select id="fbFCategory" aria-label="Category">${opt('', 'All categories', f.category)}${Object.entries(CATEGORIES).map(([k, l]) => opt(k, l, f.category)).join('')}</select>
        <select id="fbFRating" aria-label="Rating">${opt('', 'Any rating', f.rating)}${[5, 4, 3, 2, 1].map(n => opt(n, `${n} star${n > 1 ? 's' : ''}`, f.rating)).join('')}</select>
        <select id="fbFStatus" aria-label="Status">${opt('', 'Open (not archived)', f.status)}${opt('all', 'Everything', f.status)}${Object.entries(STATUSES).map(([k, l]) => opt(k, l, f.status)).join('')}</select>
        <select id="fbFSource" aria-label="Source">${opt('', 'Website and apps', f.source)}${opt('website', 'Website form', f.source)}${opt('app', 'Sent from an app', f.source)}</select>
        <select id="fbFRead" aria-label="Read">${opt('', 'Read and unread', f.read)}${opt('unread', 'Unread only', f.read)}${opt('read', 'Read only', f.read)}</select>
        <input type="date" id="fbFFrom" aria-label="From date" value="${esc(f.from || '')}">
        <input type="date" id="fbFTo" aria-label="To date" value="${esc(f.to || '')}">
      </div>
      ${isAdmin() ? `<div class="toolbar"><a class="btn btn--ghost" id="fbExport" href="#">Export these to CSV (opens in Excel)</a></div>` : ''}
      <div class="table-card"><table class="table"><thead><tr><th>Reference</th><th>Product</th><th>Rating</th><th>Category</th><th>Subject</th><th>Status</th><th>Received</th></tr></thead><tbody id="fbRows"><tr><td colspan="7"><span class="skeleton"></span></td></tr></tbody></table><div class="pager" id="fbPager"></div></div>`;
    const map = { fbQ: 'q', fbFProduct: 'product', fbFCategory: 'category', fbFRating: 'rating', fbFStatus: 'status', fbFRead: 'read', fbFSource: 'source', fbFFrom: 'from', fbFTo: 'to' };
    let t;
    Object.entries(map).forEach(([id, key]) => {
      const el = document.getElementById(id);
      el.addEventListener(id === 'fbQ' ? 'input' : 'change', () => {
        clearTimeout(t);
        t = setTimeout(() => { f[key] = el.value.trim(); f.page = 1; fillFeedback(); }, id === 'fbQ' ? 300 : 0);
      });
    });
    fillFeedback();
  }

  const filterQuery = () => {
    const p = new URLSearchParams();
    Object.entries(state.filters).forEach(([k, v]) => { if (v !== '' && v !== undefined && v !== null) p.set(k, v); });
    return p.toString();
  };

  async function fillFeedback() {
    const rows = q('#fbRows');
    const exp = q('#fbExport');
    if (exp) exp.href = `/api/feedback-admin/export.csv?${filterQuery()}`;
    try {
      const d = await api(`/api/feedback-admin/items?${filterQuery()}&limit=20`);
      rows.innerHTML = d.items.length ? d.items.map(x => `<tr class="em-row ${x.is_read ? '' : 'fb-unread'}" data-fb-item="${esc(x.id)}" tabindex="0">
        <td data-label="Reference"><strong>${esc(x.reference)}</strong>${x.suspected_spam ? ' <span class="pill pill--red">Possible spam</span>' : ''}</td>
        <td data-label="Product">${esc(x.product ? x.product.name : '—')}${x.source && x.source !== 'website' ? ` <span class="pill pill--grey">${esc(sourceLabel(x.source))}</span>` : ''}</td>
        <td data-label="Rating">${stars(x.rating)}</td>
        <td data-label="Category">${esc(CATEGORIES[x.category] || x.category)}</td>
        <td data-label="Subject">${esc(x.subject)}</td>
        <td data-label="Status">${pill(x.status)}</td>
        <td data-label="Received">${timeAgo(x.created_at)}</td></tr>`).join('')
        : '<tr><td colspan="7" class="table-empty">No feedback matches. Feedback sent through the website appears here.</td></tr>';
      const pages = Math.ceil(d.total / 20);
      q('#fbPager').innerHTML = pages > 1 ? `<span>Page ${d.page} of ${pages} · ${d.total} items</span><div>
        <button type="button" class="btn btn--ghost btn--sm" data-fb-page="-1" ${d.page <= 1 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn--ghost btn--sm" data-fb-page="1" ${d.page >= pages ? 'disabled' : ''}>Next</button></div>` : `<span>${d.total} item${d.total === 1 ? '' : 's'}</span>`;
    } catch (err) { showError(err); }
  }

  async function openItem(id) {
    try {
      const d = await api(`/api/feedback-admin/items/${id}`);
      const x = d.item;
      modalTitle.textContent = `${x.reference} · ${x.product ? x.product.name : ''}`;
      const thread = [
        ...d.responses.map(r => ({ ...r, kind: 'reply' })),
        ...d.notes.map(n => ({ ...n, kind: 'note' }))
      ].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const emailLabel = { accepted: 'Emailed (accepted by Resend)', failed: 'Email failed', not_sent: 'Not emailed' };
      modalBody.innerHTML = `
        <dl class="sys-kv">
          <dt>Rating</dt><dd>${stars(x.rating)}</dd>
          <dt>Sent from</dt><dd>${esc(sourceLabel(x.source))}</dd>
          <dt>Category</dt><dd>${esc(CATEGORIES[x.category] || x.category)}</dd>
          <dt>From</dt><dd>${esc(x.name || 'No name given')}${x.email ? ` · ${esc(x.email)}` : ' · no email given'}</dd>
          <dt>Received</dt><dd>${new Date(x.created_at).toLocaleString('en-GB')}</dd>
          <dt>Publishing</dt><dd>${x.allow_publish ? `Allowed as a testimonial${d.testimonial ? ` (${esc(d.testimonial.status)})` : ''}` : 'Not allowed'}</dd>
          ${x.suspected_spam ? '<dt>Note</dt><dd>Flagged as possible spam (many links).</dd>' : ''}
        </dl>
        <h3 class="em-subhead">${esc(x.subject)}</h3>
        <div class="fb-message">${esc(x.message)}</div>
        ${d.attachments.length ? `<h3 class="em-subhead">Attachments</h3><div class="fb-files">${d.attachments.map(a => `<button type="button" class="btn btn--ghost btn--sm" data-fb-file="${esc(a.id)}">${esc(a.file_name)} (${Math.max(1, Math.round(a.size_bytes / 1024))} KB)</button>`).join('')}</div>` : ''}
        <div class="field"><label for="fbStatusSel">Status</label><select id="fbStatusSel">${Object.entries(STATUSES).map(([k, l]) => `<option value="${k}" ${k === x.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <h3 class="em-subhead">Replies and internal notes</h3>
        <div class="fb-thread">${thread.length ? thread.map(t => `<div class="fb-thread__item ${t.kind === 'note' ? 'fb-thread__item--note' : ''}">
          <div class="fb-thread__meta"><strong>${esc(t.admin_username)}</strong> · ${new Date(t.created_at).toLocaleString('en-GB')} · ${t.kind === 'note' ? '<span class="pill pill--grey">Internal note</span>' : `<span class="pill pill--${t.email_status === 'accepted' ? 'green' : t.email_status === 'failed' ? 'red' : 'grey'}">${esc(emailLabel[t.email_status])}</span>`}${t.email_error ? ` ${esc(t.email_error)}` : ''}</div>
          <p>${esc(t.message || t.note)}</p></div>`).join('') : '<p class="em-muted">No replies or notes yet.</p>'}</div>
        <div class="field"><label for="fbReply">Reply to the customer</label><textarea id="fbReply" rows="4" maxlength="5000"></textarea></div>
        <label class="em-check"><input type="checkbox" id="fbReplyEmail" ${x.email && d.emailReady ? 'checked' : ''} ${x.email && d.emailReady ? '' : 'disabled'}> ${x.email ? (d.emailReady ? `Also email this reply to ${esc(x.email)}` : 'Email is not set up yet, so the reply is recorded here only.') : 'No email address was given, so the reply is recorded here only.'}</label>
        <div class="em-actions"><button type="button" class="btn btn--primary" data-fb-act="reply" data-id="${x.id}">Save reply</button></div>
        <div class="field"><label for="fbNote">Internal note (never shown to the customer)</label><textarea id="fbNote" rows="2" maxlength="3000"></textarea></div>
        <div class="em-actions">
          <button type="button" class="btn btn--ghost" data-fb-act="note" data-id="${x.id}">Add note</button>
          <button type="button" class="btn btn--ghost" data-fb-act="unread" data-id="${x.id}">Mark as unread</button>
          ${x.status !== 'archived' ? `<button type="button" class="btn btn--ghost" data-fb-act="archive" data-id="${x.id}">Archive</button>` : ''}
          ${isAdmin() ? `<button type="button" class="btn btn--danger" data-fb-act="delete" data-id="${x.id}">Delete</button>` : ''}
        </div>`;
      q('#fbStatusSel', modalBody).addEventListener('change', (e) => setStatus(x.id, e.target.value));
      openDialog(modal);
      if (state.tab === 'feedback') fillFeedback();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function setStatus(id, status, reopen = true) {
    try {
      await api(`/api/feedback-admin/items/${id}`, { method: 'PATCH', body: json({ status }) });
      toast(`Marked ${STATUSES[status]}.`, 'success');
      if (state.tab === 'feedback') fillFeedback();
      if (reopen) openItem(id);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function itemAction(act, id) {
    try {
      if (act === 'reply') {
        const message = q('#fbReply', modalBody).value.trim();
        if (!message) { toast('Write a reply first.', 'error'); return; }
        const { response } = await api(`/api/feedback-admin/items/${id}/responses`, { method: 'POST', body: json({ message, send_email: q('#fbReplyEmail', modalBody).checked }) });
        toast(response.email_status === 'accepted' ? 'Reply saved and emailed. Resend accepted it; that does not yet prove delivery.' : response.email_status === 'failed' ? `Reply saved, but the email failed: ${response.email_error}` : 'Reply saved.', response.email_status === 'failed' ? 'error' : 'success');
        openItem(id);
      } else if (act === 'note') {
        const note = q('#fbNote', modalBody).value.trim();
        if (!note) { toast('Write a note first.', 'error'); return; }
        await api(`/api/feedback-admin/items/${id}/notes`, { method: 'POST', body: json({ note }) });
        openItem(id);
      } else if (act === 'unread') {
        await api(`/api/feedback-admin/items/${id}`, { method: 'PATCH', body: json({ is_read: false }) });
        closeDialog(modal); toast('Marked as unread.', 'success');
        if (state.tab === 'feedback') fillFeedback();
      } else if (act === 'archive') {
        await setStatus(id, 'archived', false); closeDialog(modal);
      } else if (act === 'delete') {
        if (!await confirmDialog({ title: 'Delete this feedback?', text: 'It is removed for good, with its attachments, replies and notes.' })) return;
        await api(`/api/feedback-admin/items/${id}`, { method: 'DELETE' });
        closeDialog(modal); toast('Deleted.', 'success');
        if (state.tab === 'feedback') fillFeedback();
      }
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---------- Products ----------
  async function renderProducts() {
    const products = await loadProducts();
    const link = (p) => `${location.origin}/feedback?product=${encodeURIComponent(p.slug)}`;
    root.innerHTML = `<div class="toolbar"><button type="button" class="btn btn--primary" data-fb-product="new">Add product</button></div>
      <div class="em-tpl-grid">${products.length ? products.map(p => `<article class="card em-tpl">
        <div class="fb-product-head">${p.logo_url ? `<img class="fb-product-logo" src="${esc(p.logo_url)}" alt="">` : '<span class="fb-product-logo" aria-hidden="true"></span>'}<div><h3>${esc(p.name)}</h3>${p.is_active ? pill('approved', 'Active') : pill('archived', 'Inactive')}</div></div>
        ${p.description ? `<p class="em-muted">${esc(p.description)}</p>` : ''}
        <p class="em-muted">${p.feedbackCount} feedback · ${p.avgRating === null ? 'no ratings yet' : `${p.avgRating}★ average`} · ${p.complaints} complaint${p.complaints === 1 ? '' : 's'}</p>
        ${p.website_url ? `<a class="em-muted" href="${esc(p.website_url)}" target="_blank" rel="noopener">${esc(p.website_url)}</a>` : ''}
        <div class="fb-link"><input readonly value="${esc(link(p))}" aria-label="Feedback link for ${esc(p.name)}"><button type="button" class="btn btn--ghost btn--sm" data-fb-copy="${esc(link(p))}">Copy</button></div>
        <div class="em-actions"><button type="button" class="btn btn--ghost btn--sm" data-fb-product="${esc(p.id)}">Edit</button>
          <button type="button" class="btn btn--ghost btn--sm" data-fb-toggle="${esc(p.id)}" data-active="${p.is_active}">${p.is_active ? 'Deactivate' : 'Activate'}</button>
          <button type="button" class="btn btn--ghost btn--sm" data-fb-view="${esc(p.id)}">View feedback</button></div>
      </article>`).join('') : '<p class="em-muted">No products yet. Add one to open it for feedback.</p>'}</div>`;
  }

  function editProduct(p) {
    modalTitle.textContent = p ? `Edit ${p.name}` : 'Add product';
    const f = (id, label, value, type = 'text', hint = '') => `<div class="field"><label for="${id}">${label}</label>${type === 'textarea' ? `<textarea id="${id}" rows="3">${esc(value || '')}</textarea>` : `<input id="${id}" type="${type}" value="${esc(value ?? '')}">`}${hint ? `<p class="field__hint">${hint}</p>` : ''}</div>`;
    modalBody.innerHTML = `
      ${f('fpName', 'Product name', p && p.name)}
      ${f('fpSlug', 'Link name', p && p.slug, 'text', 'Used in the feedback link, e.g. /feedback?product=job-rush. Lowercase letters, numbers and dashes.')}
      ${f('fpDesc', 'Description', p && p.description, 'textarea')}
      ${f('fpSite', 'Website link', p && p.website_url, 'url')}
      ${f('fpLogo', 'Logo', p && p.logo_url, 'url', 'Upload an image, or paste a full https:// address.')}
      <input type="file" id="fpLogoFile" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="Upload a logo">
      ${f('fpOrder', 'Order in the list', p ? p.display_order : 0, 'number')}
      <label class="em-check"><input type="checkbox" id="fpActive" ${!p || p.is_active ? 'checked' : ''}> Open for feedback</label>
      <div class="em-actions"><button type="button" class="btn btn--primary" id="fpSave">Save product</button></div>`;
    const name = q('#fpName', modalBody); const slug = q('#fpSlug', modalBody);
    if (!p) name.addEventListener('input', () => { slug.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); });
    q('#fpLogoFile', modalBody).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData(); fd.append('file', file); fd.append('folder', 'products');
      try { q('#fpLogo', modalBody).value = (await api('/api/upload', { method: 'POST', body: fd })).url; toast('Logo uploaded.', 'success'); } catch (err) { toast(err.message, 'error'); }
    });
    q('#fpSave', modalBody).addEventListener('click', async () => {
      const body = { name: name.value, slug: slug.value, description: q('#fpDesc', modalBody).value, website_url: q('#fpSite', modalBody).value.trim(), logo_url: q('#fpLogo', modalBody).value.trim(), display_order: q('#fpOrder', modalBody).value, is_active: q('#fpActive', modalBody).checked };
      try {
        if (p) await api(`/api/feedback-admin/products/${p.id}`, { method: 'PUT', body: json(body) });
        else await api('/api/feedback-admin/products', { method: 'POST', body: json(body) });
        closeDialog(modal); toast('Product saved. It is on the feedback form when active.', 'success'); renderProducts();
      } catch (err) { toast(err.message, 'error'); }
    });
    openDialog(modal);
  }

  // ---------- Testimonials ----------
  async function loadTestimonials() {
    const products = state.products.length ? state.products : await loadProducts();
    root.innerHTML = `<div class="toolbar">
        <select id="ftStatus" aria-label="Status"><option value="">All</option><option value="pending">Waiting for approval</option><option value="approved">Published</option><option value="unpublished">Unpublished</option><option value="rejected">Rejected</option></select>
        <select id="ftProduct" aria-label="Product"><option value="">All products</option>${products.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
        <label class="em-check"><input type="checkbox" id="ftPositive"> 4 and 5 stars only</label>
      </div>
      <p class="em-muted">Only feedback whose author ticked "You may publish my review" appears here. Nothing is published until you approve it. Featured testimonials also show in the homepage reviews.</p>
      <div class="em-tpl-grid" id="ftList"><span class="skeleton"></span></div>`;
    ['ftStatus', 'ftProduct', 'ftPositive'].forEach(id => document.getElementById(id).addEventListener('change', fillTestimonials));
    fillTestimonials();
  }

  async function fillTestimonials() {
    const p = new URLSearchParams();
    if (q('#ftStatus').value) p.set('status', q('#ftStatus').value);
    if (q('#ftProduct').value) p.set('product', q('#ftProduct').value);
    if (q('#ftPositive').checked) p.set('positive', '1');
    try {
      const { testimonials } = await api(`/api/feedback-admin/testimonials?${p}`);
      q('#ftList').innerHTML = testimonials.length ? testimonials.map(t => `<article class="card em-tpl">
        <div class="fb-thread__meta">${pill(t.status, { pending: 'Waiting for approval', approved: 'Published', rejected: 'Rejected', unpublished: 'Unpublished' }[t.status])}${t.featured ? ' <span class="pill pill--blue">Featured</span>' : ''} ${esc(t.product ? t.product.name : '')}</div>
        ${stars(t.rating)}
        <p>${esc(t.quote.length > 280 ? `${t.quote.slice(0, 280)}…` : t.quote)}</p>
        <p class="em-muted">${esc(t.display_name)} · ${fmtDate(t.created_at)}${t.feedback ? ` · ${esc(t.feedback.reference)}` : ''}</p>
        <div class="em-actions">
          ${t.status !== 'approved' ? `<button type="button" class="btn btn--primary btn--sm" data-ft="${t.id}" data-set="approved">Approve</button>` : `<button type="button" class="btn btn--ghost btn--sm" data-ft="${t.id}" data-feature="${!t.featured}">${t.featured ? 'Unfeature' : 'Feature'}</button><button type="button" class="btn btn--ghost btn--sm" data-ft="${t.id}" data-set="unpublished">Unpublish</button>`}
          ${t.status === 'pending' ? `<button type="button" class="btn btn--ghost btn--sm" data-ft="${t.id}" data-set="rejected">Reject</button>` : ''}
        </div></article>`).join('') : '<p class="em-muted">Nothing here yet.</p>';
    } catch (err) { showError(err); }
  }

  // ---------- Analytics ----------
  async function loadAnalytics() {
    const d = await api('/api/feedback-admin/analytics');
    const who = (x, text) => (x ? `<strong>${esc(x.name)}</strong><small>${esc(text(x))}</small>` : '<strong>—</strong><small>Not enough feedback yet</small>');
    const words = (list, none) => (list.length ? hbars(list.map(w => ({ label: w.word, value: w.count }))) : `<p class="empty-chart">${none}</p>`);
    root.innerHTML = `
      <div class="em-stats">
        <div class="em-stat"><span class="em-stat__label">Most reviewed</span>${who(d.mostReviewed, x => `${x.count} pieces of feedback`)}</div>
        <div class="em-stat"><span class="em-stat__label">Highest rated</span>${who(d.highestRated, x => `${x.avgRating}★ from ${x.count} ratings (at least 3 needed)`)}</div>
        <div class="em-stat"><span class="em-stat__label">Most complaints</span>${who(d.mostComplaints, x => `${x.complaints} complaint${x.complaints === 1 ? '' : 's'}`)}</div>
      </div>
      <div class="fb-grid">
        ${card('Customer satisfaction', 'Average rating per month, last 12 months', d.satisfaction.some(m => m.count) ? columns(d.satisfaction.map(m => ({ label: m.label, value: m.avgRating })), '★ average') : empty)}
        ${card('Products compared', 'Average rating', d.byProduct.some(p => p.count) ? hbars(d.byProduct.filter(p => p.count).map(p => ({ label: p.name, value: p.avgRating, n: p.count })), r => `${r.value}★ (${r.n})`) : empty)}
        ${card('Commonly reported problems', 'Words that recur in bug report and complaint subjects', words(d.commonProblems, 'No recurring words yet.'))}
        ${card('Most requested features', 'Words that recur in feature request and suggestion subjects', words(d.requestedFeatures, 'No recurring words yet.'))}
      </div>
      ${isAdmin() ? '<div class="toolbar"><a class="btn btn--ghost" href="/api/feedback-admin/export.csv?status=all">Download the full report (CSV, opens in Excel)</a></div>' : ''}`;
  }

  // ---------- Events ----------
  document.getElementById('feedbackTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-fb-tab]'); if (b) setTab(b.dataset.fbTab); });
  root.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-fb-reload]')) return setTab(state.tab);
    const row = t.closest('[data-fb-item]');
    if (row) return openItem(row.dataset.fbItem);
    const pg = t.closest('[data-fb-page]');
    if (pg) { state.filters.page = (state.filters.page || 1) + Number(pg.dataset.fbPage); return fillFeedback(); }
    const prod = t.closest('[data-fb-product]');
    if (prod) return editProduct(prod.dataset.fbProduct === 'new' ? null : state.products.find(p => p.id === prod.dataset.fbProduct));
    const copy = t.closest('[data-fb-copy]');
    if (copy) { try { await navigator.clipboard.writeText(copy.dataset.fbCopy); toast('Link copied.', 'success'); } catch { toast('Select the link and copy it.', 'info'); } return undefined; }
    const tog = t.closest('[data-fb-toggle]');
    if (tog) {
      try { await api(`/api/feedback-admin/products/${tog.dataset.fbToggle}`, { method: 'PUT', body: json({ is_active: tog.dataset.active !== 'true' }) }); renderProducts(); } catch (err) { toast(err.message, 'error'); }
      return undefined;
    }
    const view = t.closest('[data-fb-view]');
    if (view) { state.filters = { page: 1, product: view.dataset.fbView, status: 'all' }; return setTab('feedback'); }
    const ft = t.closest('[data-ft]');
    if (ft) {
      const body = ft.dataset.set ? { status: ft.dataset.set } : { featured: ft.dataset.feature === 'true' };
      try { await api(`/api/feedback-admin/testimonials/${ft.dataset.ft}`, { method: 'PATCH', body: json(body) }); fillTestimonials(); } catch (err) { toast(err.message, 'error'); }
    }
    return undefined;
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-fb-item]')) openItem(e.target.dataset.fbItem); });
  modalBody.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-fb-act]');
    if (act) itemAction(act.dataset.fbAct, act.dataset.id);
    const file = e.target.closest('[data-fb-file]');
    if (file) {
      try { const { url } = await api(`/api/feedback-admin/attachments/${file.dataset.fbFile}`); window.open(url, '_blank', 'noopener'); } catch (err) { toast(err.message, 'error'); }
    }
  });

  // ---------- Automatic updates ----------
  // While the module is open and the browser tab is visible, the overview and the
  // feedback list refresh every 30 seconds, so new feedback and status changes
  // appear without reloading. A plain request: a refusal never opens the login prompt.
  const REFRESH_MS = 30 * 1000;
  const viewOpen = () => !document.getElementById('view-feedback').hidden && document.visibilityState === 'visible';
  const modalOpen = () => !modal.hidden;
  async function refreshBadge() {
    try {
      const r = await fetch('/api/feedback-admin/overview', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      const b = document.getElementById('feedbackBadge');
      if (b) { b.textContent = d.unread; b.hidden = !d.unread; }
    } catch { /* offline: try again next time */ }
  }
  function refreshNow() {
    if (document.visibilityState !== 'visible') return;
    refreshBadge();
    // Don't redraw underneath someone reading or typing in a feedback item
    if (!viewOpen() || modalOpen()) return;
    if (state.tab === 'overview') loadOverview().catch(() => {});
    if (state.tab === 'feedback' && document.activeElement && !document.activeElement.closest('.fb-filters')) fillFeedback();
  }
  setInterval(refreshNow, REFRESH_MS);
  // Coming back to the tab shows what arrived meanwhile straight away
  document.addEventListener('visibilitychange', refreshNow);

  window.FeedbackCenter = { load: () => setTab(state.tab) };
  if (/^#\/feedback/.test(location.hash) && !document.getElementById('view-feedback').hidden) window.FeedbackCenter.load();
  // The sidebar shows how much feedback is unread
  refreshBadge();
})();
