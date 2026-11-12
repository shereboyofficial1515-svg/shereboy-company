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
  const SENTIMENT = { positive: ['green', 'Positive'], neutral: ['grey', 'Neutral'], negative: ['red', 'Negative'] };
  const CLASSIFY = { complaint: 'Complaint', suggestion: 'Suggestion', question: 'Question', positive_review: 'Positive review', general_enquiry: 'General enquiry' };
  const KIND = { confirmation: 'Confirmation', reply: 'Reply', info_request: 'Request for information', follow_up: 'Follow-up', under_review: 'Under review update', resolved: 'Resolution notice', ai_reply: 'AI reply', customer_reply: 'Customer reply' };
  const EMAIL_STATUS = { pending_approval: ['amber', 'Waiting for approval'], sending: ['amber', 'Sending'], sent: ['green', 'Sent (accepted by Resend)'], failed: ['red', 'Failed'], discarded: ['grey', 'Discarded'], received: ['blue', 'Received'] };
  const CONFIRM = { not_required: ['grey', 'Not needed (no email)'], pending: ['amber', 'Sending'], sent: ['green', 'Sent'], failed: ['red', 'Failed'] };
  const tag = (map, key) => (map[key] ? `<span class="pill pill--${map[key][0]}">${esc(map[key][1])}</span>` : '');
  const busy = (btn, on, text) => { if (!btn) return; if (on) { btn.dataset.label = btn.textContent; btn.textContent = text || 'Working…'; btn.disabled = true; } else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; } };
  const sourceLabel = (s) => (!s || s === 'website' ? 'Website' : `${s.replace(/-app$/, '').replace(/-/g, ' ').toUpperCase()} app`);
  const skeleton = '<div class="card"><span class="skeleton"></span><br><span class="skeleton"></span><br><span class="skeleton"></span></div>';
  const state = { tab: 'overview', filters: { page: 1 }, products: [] };

  function showError(err) {
    root.innerHTML = err.code === 'MIGRATION_REQUIRED'
      ? `<div class="card em-notice"><h2>One step left: update the database</h2><p>Back up your database, then run <code>${esc((/migrations\/([\w.-]+\.sql)/.exec(err.message || '') || [])[1] || '2026-11-06-reviews-feedback.sql')}</code> in the Supabase SQL Editor.</p></div>`
      : `<div class="card em-notice"><p>${esc(err.message)}</p><button type="button" class="btn btn--ghost" data-fb-reload>Try again</button></div>`;
  }

  async function loadProducts() {
    const { products } = await api('/api/feedback-admin/products');
    state.products = products;
    return products;
  }

  function setTab(tab) {
    state.tab = ['overview', 'feedback', 'products', 'testimonials', 'analytics', 'assistant'].includes(tab) ? tab : 'overview';
    qa('[data-fb-tab]', document.getElementById('feedbackTabs')).forEach(b => {
      const on = b.dataset.fbTab === state.tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    root.innerHTML = skeleton;
    ({ overview: loadOverview, feedback: loadFeedback, products: renderProducts, testimonials: loadTestimonials, analytics: loadAnalytics, assistant: loadAssistant })[state.tab]().catch(showError);
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
      ${d.comms ? `<div class="em-stats em-stats--tight">
        ${stat('Positive', d.sentiment.positive)}${stat('Neutral', d.sentiment.neutral)}${stat('Negative', d.sentiment.negative, d.sentiment.unanalysed ? `${d.sentiment.unanalysed} not analysed` : '')}
        ${stat('Needs attention', d.needsAttention, 'Open, flagged for a person')}${stat('Handled by AI', d.aiHandled)}${stat('Awaiting customer', d.awaitingCustomer, 'We asked for more information')}${stat('AI replies to approve', d.pendingApproval)}
      </div>` : ''}
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
        <select id="fbFSentiment" aria-label="Sentiment">${opt('', 'Any sentiment', f.sentiment)}${Object.entries(SENTIMENT).map(([k, v]) => opt(k, v[1], f.sentiment)).join('')}</select>
        <select id="fbFFlag" aria-label="Needs action">${opt('', 'Everything', f.flag)}${opt('attention', 'Needs attention', f.flag)}${opt('awaiting', 'Awaiting customer reply', f.flag)}</select>
        <select id="fbFRead" aria-label="Read">${opt('', 'Read and unread', f.read)}${opt('unread', 'Unread only', f.read)}${opt('read', 'Read only', f.read)}</select>
        <input type="date" id="fbFFrom" aria-label="From date" value="${esc(f.from || '')}">
        <input type="date" id="fbFTo" aria-label="To date" value="${esc(f.to || '')}">
      </div>
      ${isAdmin() ? `<div class="toolbar"><a class="btn btn--ghost" id="fbExport" href="#">Export these to CSV (opens in Excel)</a></div>` : ''}
      <div class="table-card"><table class="table"><thead><tr><th>Reference</th><th>Product</th><th>Rating</th><th>Category</th><th>Subject</th><th>Status</th><th>Received</th></tr></thead><tbody id="fbRows"><tr><td colspan="7"><span class="skeleton"></span></td></tr></tbody></table><div class="pager" id="fbPager"></div></div>`;
    const map = { fbQ: 'q', fbFProduct: 'product', fbFCategory: 'category', fbFRating: 'rating', fbFStatus: 'status', fbFRead: 'read', fbFSource: 'source', fbFSentiment: 'sentiment', fbFFlag: 'flag', fbFFrom: 'from', fbFTo: 'to' };
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
        <td data-label="Subject">${esc(x.subject)}${x.needs_attention ? ' <span class="pill pill--red">Needs attention</span>' : ''}${x.awaiting_customer ? ' <span class="pill pill--amber">Awaiting customer</span>' : ''} ${tag(SENTIMENT, x.sentiment)}</td>
        <td data-label="Status">${pill(x.status)}</td>
        <td data-label="Received">${timeAgo(x.created_at)}</td></tr>`).join('')
        : '<tr><td colspan="7" class="table-empty">No feedback matches. Feedback sent through the website appears here.</td></tr>';
      const pages = Math.ceil(d.total / 20);
      q('#fbPager').innerHTML = pages > 1 ? `<span>Page ${d.page} of ${pages} · ${d.total} items</span><div>
        <button type="button" class="btn btn--ghost btn--sm" data-fb-page="-1" ${d.page <= 1 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn--ghost btn--sm" data-fb-page="1" ${d.page >= pages ? 'disabled' : ''}>Next</button></div>` : `<span>${d.total} item${d.total === 1 ? '' : 's'}</span>`;
    } catch (err) { showError(err); }
  }

  function emailItem(e) {
    const inbound = e.direction === 'inbound';
    return `<div class="fb-thread__item ${inbound ? 'fb-thread__item--in' : ''}">
      <div class="fb-thread__meta"><strong>${esc(inbound ? 'Customer' : e.author)}</strong> · ${new Date(e.created_at).toLocaleString('en-GB')} · <span class="pill pill--grey">${esc(KIND[e.kind] || e.kind)}</span> ${tag(EMAIL_STATUS, e.status)}${e.ai_generated ? ' <span class="pill pill--blue">AI-written</span>' : ''}${e.attempts > 1 ? ` · ${e.attempts} attempts` : ''}${e.error ? ` · ${esc(e.error)}` : ''}</div>
      ${inbound ? '' : `<p><strong>${esc(e.subject)}</strong></p>`}
      <p>${esc(e.body)}</p>
      ${e.status === 'failed' ? `<div class="em-actions"><button type="button" class="btn btn--ghost btn--sm" data-fb-act="retry-email" data-email="${esc(e.id)}">Retry sending</button></div>` : ''}
      ${e.status === 'pending_approval' ? `<div class="em-actions"><button type="button" class="btn btn--primary btn--sm" data-fb-act="approve" data-email="${esc(e.id)}">Approve and send</button><button type="button" class="btn btn--ghost btn--sm" data-fb-act="edit-approve" data-email="${esc(e.id)}">Edit before sending</button><button type="button" class="btn btn--ghost btn--sm" data-fb-act="discard" data-email="${esc(e.id)}">Discard</button></div>` : ''}
    </div>`;
  }

  function aiPanel(d) {
    const x = d.item;
    if (!d.comms) return '';
    const head = `<div class="fb-ai__head"><h3 class="em-subhead">AI assistant</h3>${d.aiReady ? `<button type="button" class="btn btn--ghost btn--sm" data-fb-act="analyze" data-id="${x.id}">Analyse again</button>` : ''}</div>`;
    if (!d.aiReady) return `<section class="fb-ai">${head}<p class="em-muted">The AI assistant is off: GEMINI_API_KEY is not set on the server.</p></section>`;
    if (x.ai_status === 'pending') return `<section class="fb-ai">${head}<p class="em-muted">Analysing this feedback… it appears here in a few seconds.</p></section>`;
    if (x.ai_status !== 'done') return `<section class="fb-ai">${head}<p class="em-muted">${x.ai_status === 'failed' ? 'The last analysis failed (the AI service did not answer). Press Analyse again.' : 'Not analysed yet.'}</p></section>`;
    const qs = Array.isArray(x.ai_follow_up_questions) ? x.ai_follow_up_questions : [];
    return `<section class="fb-ai">${head}
      <div class="fb-thread__meta">${x.ai_classification ? `<span class="pill pill--blue">${esc(CLASSIFY[x.ai_classification] || x.ai_classification)}</span>` : ''} ${tag(SENTIMENT, x.sentiment)}${x.needs_attention ? ' <span class="pill pill--red">Needs attention</span>' : ''}</div>
      ${x.needs_attention && x.attention_reason ? `<p class="fb-ai__warn">${esc(x.attention_reason)} The AI will not reply to this automatically.</p>` : ''}
      ${x.ai_summary ? `<p>${esc(x.ai_summary)}</p>` : ''}
      ${qs.length ? `<p class="em-muted">Suggested follow-up questions:</p><ul class="fb-ai__qs">${qs.map((q, i) => `<li>${esc(q)} <button type="button" class="btn btn--ghost btn--sm" data-fb-act="ask-q" data-q="${i}">Ask this</button></li>`).join('')}</ul>` : ''}
      ${x.ai_suggested_reply ? `<details class="fb-ai__reply"><summary>Suggested reply</summary><p>${esc(x.ai_suggested_reply)}</p><button type="button" class="btn btn--ghost btn--sm" data-fb-act="use-suggested">Use as a draft</button></details>` : ''}
    </section>`;
  }

  function composer(d) {
    const x = d.item;
    if (!d.comms) return '';
    if (!x.email) return '<p class="em-muted">This customer left no email address, so they cannot be emailed. Feedback sent from inside an app has no email.</p>';
    return `<section class="fb-compose" id="fbCompose">
      <h3 class="em-subhead">Email the customer</h3>
      <div class="fb-compose__row">
        <div class="field"><label for="fbcKind">Type</label><select id="fbcKind"><option value="reply">Reply</option><option value="info_request">Ask for more information</option><option value="follow_up">Follow-up</option><option value="resolved">Resolution notice (marks it resolved)</option></select></div>
        <div class="field"><label for="fbcTone">Tone</label><select id="fbcTone"><option value="professional">Professional</option><option value="friendly">Friendly</option><option value="apologetic">Apologetic</option><option value="formal">Formal</option><option value="reassuring">Reassuring</option></select></div>
      </div>
      ${d.aiReady ? `<div class="field"><label for="fbcInstruction">Tell the AI what to write (optional)</label><textarea id="fbcInstruction" rows="2" maxlength="1000" placeholder="e.g. Ask this customer to explain the problem they had while using our service, and request a screenshot."></textarea></div>
      <div class="em-actions fb-compose__ai">
        <button type="button" class="btn btn--ghost btn--sm" data-fb-act="compose" data-mode="generate">Generate message</button>
        <button type="button" class="btn btn--ghost btn--sm" data-fb-act="compose" data-mode="regenerate">Regenerate</button>
        <button type="button" class="btn btn--ghost btn--sm" data-fb-act="compose" data-mode="improve">Improve message</button>
        <button type="button" class="btn btn--ghost btn--sm" data-fb-act="compose" data-mode="shorter">Make shorter</button>
        <button type="button" class="btn btn--ghost btn--sm" data-fb-act="compose" data-mode="professional">Make more professional</button>
      </div>` : ''}
      <div class="field"><label for="fbcSubject">Subject</label><input id="fbcSubject" maxlength="200" value="${esc(`Re: ${x.subject} (${x.reference})`)}"></div>
      <div class="field"><label for="fbcBody">Message to ${esc(x.email)}</label><textarea id="fbcBody" rows="10" maxlength="6000"></textarea>
        <p class="field__hint" id="fbcHint">Nothing is sent until you press Send email. You can edit anything the AI writes.</p></div>
      <div class="em-actions"><button type="button" class="btn btn--ghost" data-fb-act="copy">Copy message</button><button type="button" class="btn btn--primary" data-fb-act="send" data-id="${x.id}">Send email</button><button type="button" class="btn btn--ghost" data-fb-act="cancel-approve" hidden>Cancel editing</button></div>
      <div class="field"><label for="fbCustReply">Customer replied by email? Paste their reply to keep the conversation complete</label><textarea id="fbCustReply" rows="3" maxlength="6000"></textarea></div>
      <div class="em-actions"><button type="button" class="btn btn--ghost btn--sm" data-fb-act="cust-reply" data-id="${x.id}">Add customer reply</button></div>
    </section>`;
  }

  async function openItem(id) {
    try {
      const d = await api(`/api/feedback-admin/items/${id}`);
      const x = d.item;
      state.current = d;
      state.aiUsed = false;
      state.approving = null;
      modalTitle.textContent = `${x.reference} · ${x.product ? x.product.name : ''}`;
      const thread = [
        ...d.responses.map(r => ({ ...r, type: 'response' })),
        ...d.notes.map(n => ({ ...n, type: 'note' })),
        ...(d.emails || []).map(e => ({ ...e, type: 'email' }))
      ].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const emailLabel = { accepted: 'Emailed (accepted by Resend)', failed: 'Email failed', not_sent: 'Not emailed' };
      const confirmRetry = d.comms && x.email && x.confirmation_status !== 'sent';
      modalBody.innerHTML = `
        <dl class="sys-kv">
          <dt>Rating</dt><dd>${stars(x.rating)}</dd>
          <dt>Sent from</dt><dd>${esc(sourceLabel(x.source))}</dd>
          <dt>Category</dt><dd>${esc(CATEGORIES[x.category] || x.category)}</dd>
          <dt>From</dt><dd>${esc(x.name || 'No name given')}${x.email ? ` · <a href="mailto:${esc(x.email)}">${esc(x.email)}</a>` : ' · no email given'}</dd>
          ${d.comms && x.email ? `<dt>Confirmation email</dt><dd>${tag(CONFIRM, x.confirmation_status)}${x.confirmation_error ? ` ${esc(x.confirmation_error)}` : ''}${confirmRetry ? ` <button type="button" class="btn btn--ghost btn--sm" data-fb-act="confirm-retry" data-id="${x.id}">${x.confirmation_status === 'failed' ? 'Retry' : 'Send now'}</button>` : ''}</dd>` : ''}
          <dt>Received</dt><dd>${new Date(x.created_at).toLocaleString('en-GB')}</dd>
          <dt>Publishing</dt><dd>${x.allow_publish ? `Allowed as a testimonial${d.testimonial ? ` (${esc(d.testimonial.status)})` : ''}` : 'Not allowed'}</dd>
          ${x.suspected_spam ? '<dt>Note</dt><dd>Flagged as possible spam: it contains many links, or a hidden anti-spam field was filled in (browser autofill can do that for real people). It was kept so nothing genuine is lost; no confirmation email or AI reply was sent. Delete it if it is spam.</dd>' : ''}
        </dl>
        <h3 class="em-subhead">${esc(x.subject)}</h3>
        <div class="fb-message">${esc(x.message)}</div>
        ${d.attachments.length ? `<h3 class="em-subhead">Attachments</h3><div class="fb-files">${d.attachments.map(a => `<button type="button" class="btn btn--ghost btn--sm" data-fb-file="${esc(a.id)}">${esc(a.file_name)} (${Math.max(1, Math.round(a.size_bytes / 1024))} KB)</button>`).join('')}</div>` : ''}
        ${aiPanel(d)}
        <div class="field"><label for="fbStatusSel">Status</label><select id="fbStatusSel">${Object.entries(STATUSES).map(([k, l]) => `<option value="${k}" ${k === x.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${d.comms && x.email ? '<p class="field__hint">Marking it Under Review or Resolved emails the customer once, if status emails are on (AI Assistant tab).</p>' : ''}</div>
        <h3 class="em-subhead">Conversation and internal notes</h3>
        <div class="fb-thread">${thread.length ? thread.map(t => (t.type === 'email' ? emailItem(t) : `<div class="fb-thread__item ${t.type === 'note' ? 'fb-thread__item--note' : ''}">
          <div class="fb-thread__meta"><strong>${esc(t.admin_username)}</strong> · ${new Date(t.created_at).toLocaleString('en-GB')} · ${t.type === 'note' ? '<span class="pill pill--grey">Internal note</span>' : `<span class="pill pill--${t.email_status === 'accepted' ? 'green' : t.email_status === 'failed' ? 'red' : 'grey'}">${esc(emailLabel[t.email_status])}</span>`}${t.email_error ? ` ${esc(t.email_error)}` : ''}</div>
          <p>${esc(t.message || t.note)}</p></div>`)).join('') : '<p class="em-muted">No emails, replies or notes yet.</p>'}</div>
        ${d.comms && x.email ? composer(d) : `${composer(d)}<div class="field"><label for="fbReply">${d.comms ? 'Record a reply (not emailed)' : 'Reply to the customer'}</label><textarea id="fbReply" rows="4" maxlength="5000"></textarea></div>
        <label class="em-check"><input type="checkbox" id="fbReplyEmail" ${x.email && d.emailReady ? 'checked' : ''} ${x.email && d.emailReady ? '' : 'disabled'}> ${x.email ? (d.emailReady ? `Also email this reply to ${esc(x.email)}` : 'Email is not set up yet, so the reply is recorded here only.') : 'No email address was given, so the reply is recorded here only.'}</label>
        <div class="em-actions"><button type="button" class="btn btn--primary" data-fb-act="reply" data-id="${x.id}">Save reply</button></div>`}
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

  // The composer belongs to the open ticket
  const cv = (id) => { const el = q(id, modalBody); return el ? el.value.trim() : ''; };
  function setDraft({ subject, body }) {
    if (subject !== undefined) q('#fbcSubject', modalBody).value = subject;
    if (body !== undefined) q('#fbcBody', modalBody).value = body;
    q('#fbcBody', modalBody).focus();
  }

  async function commsAction(act, el) {
    const d = state.current;
    const x = d && d.item;
    if (act === 'compose') {
      const mode = el.dataset.mode;
      busy(el, true, 'Writing…');
      try {
        const { draft } = await api(`/api/feedback-admin/items/${x.id}/compose`, { method: 'POST', body: json({ action: mode, instruction: cv('#fbcInstruction'), tone: cv('#fbcTone'), draft: cv('#fbcBody') }) });
        setDraft(['improve', 'shorter', 'professional'].includes(mode) ? { body: draft.body } : draft);
        state.aiUsed = true;
        q('#fbcHint', modalBody).textContent = 'Written by AI. Read and edit it before sending: nothing is sent until you press Send email.';
      } catch (err) { toast(err.message, 'error'); } finally { busy(el, false); }
      return;
    }
    if (act === 'use-suggested') { setDraft({ body: x.ai_suggested_reply }); state.aiUsed = true; return; }
    if (act === 'ask-q') {
      const question = x.ai_follow_up_questions[Number(el.dataset.q)];
      const body = q('#fbcBody', modalBody);
      if (!body) return;
      q('#fbcKind', modalBody).value = 'info_request';
      body.value = `${body.value ? `${body.value}\n\n` : `Hello ${x.name ? x.name.split(/\s+/)[0] : 'there'},\n\nThank you for your feedback. To help us look into it, could you tell us:\n\n`}- ${question}`;
      body.focus();
      return;
    }
    if (act === 'copy') {
      const text = `${cv('#fbcSubject')}\n\n${cv('#fbcBody')}`;
      try { await navigator.clipboard.writeText(text); toast('Message copied.', 'success'); } catch { q('#fbcBody', modalBody).select(); toast('Press Ctrl+C to copy the selected message.', 'info'); }
      return;
    }
    if (act === 'send') {
      const subject = cv('#fbcSubject'); const body = cv('#fbcBody');
      if (body.length < 10) { toast('Write the message first.', 'error'); q('#fbcBody', modalBody).focus(); return; }
      busy(el, true, 'Sending…');
      try {
        const r = state.approving
          ? await api(`/api/feedback-admin/emails/${state.approving}/approve`, { method: 'POST', body: json({ subject, body }) })
          : await api(`/api/feedback-admin/items/${x.id}/emails`, { method: 'POST', body: json({ kind: cv('#fbcKind'), subject, body, ai_assisted: state.aiUsed }) });
        toast(r.email.status === 'sent' ? `Email sent to ${x.email}.` : `Saved, but the email failed: ${r.email.error}. You can retry it from the conversation.`, r.email.status === 'sent' ? 'success' : 'error');
        openItem(x.id);
      } catch (err) { toast(err.message, 'error'); busy(el, false); }
      return;
    }
    if (act === 'edit-approve') {
      const e = (d.emails || []).find(m => m.id === el.dataset.email);
      if (!e || !q('#fbcBody', modalBody)) return;
      state.approving = e.id;
      setDraft({ subject: e.subject, body: e.body });
      q('#fbcHint', modalBody).textContent = 'You are editing the AI reply waiting for approval. Send email approves and sends it.';
      q('[data-fb-act="cancel-approve"]', modalBody).hidden = false;
      q('#fbCompose', modalBody).scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (act === 'cancel-approve') { openItem(x.id); return; }
    busy(el, true);
    try {
      if (act === 'analyze') {
        await api(`/api/feedback-admin/items/${x.id}/analyze`, { method: 'POST', body: json({}) });
        toast('Analysis updated.', 'success');
      } else if (act === 'approve') {
        const r = await api(`/api/feedback-admin/emails/${el.dataset.email}/approve`, { method: 'POST', body: json({}) });
        toast(r.email.status === 'sent' ? 'AI reply approved and sent.' : `The email failed: ${r.email.error}`, r.email.status === 'sent' ? 'success' : 'error');
      } else if (act === 'discard') {
        await api(`/api/feedback-admin/emails/${el.dataset.email}/discard`, { method: 'POST', body: json({}) });
        toast('Draft discarded. Nothing was sent.', 'success');
      } else if (act === 'retry-email') {
        const r = await api(`/api/feedback-admin/emails/${el.dataset.email}/retry`, { method: 'POST', body: json({}) });
        toast(r.email.status === 'sent' ? 'Sent.' : `Still failing: ${r.email.error}`, r.email.status === 'sent' ? 'success' : 'error');
      } else if (act === 'confirm-retry') {
        const r = await api(`/api/feedback-admin/items/${x.id}/confirmation/retry`, { method: 'POST', body: json({}) });
        toast(r.email.status === 'sent' ? 'Confirmation email sent.' : `Still failing: ${r.email.error}`, r.email.status === 'sent' ? 'success' : 'error');
      } else if (act === 'cust-reply') {
        const body = cv('#fbCustReply');
        if (!body) { toast('Paste the customer\'s reply first.', 'error'); busy(el, false); return; }
        await api(`/api/feedback-admin/items/${x.id}/customer-reply`, { method: 'POST', body: json({ body }) });
        toast('Customer reply added to the conversation.', 'success');
      }
      openItem(x.id);
    } catch (err) { toast(err.message, 'error'); busy(el, false); }
  }

  async function setStatus(id, status, reopen = true) {
    try {
      const r = await api(`/api/feedback-admin/items/${id}`, { method: 'PATCH', body: json({ status }) });
      const se = r.statusEmail;
      toast(`Marked ${STATUSES[status]}.${se ? (se.status === 'sent' ? ' The customer was emailed.' : ` The customer email failed: ${se.error}`) : ''}`, se && se.status === 'failed' ? 'error' : 'success');
      if (state.tab === 'feedback') fillFeedback();
      if (reopen) openItem(id);
    } catch (err) { toast(err.message, 'error'); }
  }

  const COMMS_ACTS = ['compose', 'use-suggested', 'ask-q', 'copy', 'send', 'edit-approve', 'cancel-approve', 'analyze', 'approve', 'discard', 'retry-email', 'confirm-retry', 'cust-reply'];
  async function itemAction(act, id, el) {
    if (COMMS_ACTS.includes(act)) return commsAction(act, el);
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

  // ---------- AI Assistant ----------
  async function loadAssistant() {
    const d = await api('/api/feedback-admin/ai/overview');
    const s = d.settings;
    const list = (items, empty, extra = () => '') => (items.length ? `<div class="fb-thread">${items.slice(0, 15).map(r => `<div class="fb-thread__item em-row" data-fb-item="${esc(r.id)}" tabindex="0">
        <div class="fb-thread__meta"><strong>${esc(r.reference)}</strong> · ${esc(r.product || '')} · ${timeAgo(r.created_at)} ${pill(r.status)} ${tag(SENTIMENT, r.sentiment)}${r.classification ? ` <span class="pill pill--blue">${esc(CLASSIFY[r.classification])}</span>` : ''}</div>
        <p><strong>${esc(r.subject)}</strong>${r.summary ? ` · ${esc(r.summary)}` : ''}</p>${extra(r)}</div>`).join('')}${items.length > 15 ? `<p class="em-muted">And ${items.length - 15} more.</p>` : ''}</div>` : `<p class="em-muted">${empty}</p>`);
    const toggle = (key, label, hint) => `<label class="em-check"><input type="checkbox" data-fb-setting="${key}" ${s[key] ? 'checked' : ''} ${isAdmin() ? '' : 'disabled'}> <span><strong>${label}</strong><br><small class="em-muted">${hint}</small></span></label>`;
    root.innerHTML = `
      ${d.aiConfigured ? '' : '<div class="card em-notice"><p><strong>The AI is not configured.</strong> Set GEMINI_API_KEY on the server (Render, Environment) to turn on analysis and message writing. Customer emails work without it.</p></div>'}
      <div class="em-stats">
        ${stat('Analysed by AI', d.analysed, d.analysisFailed ? `${d.analysisFailed} failed: open them and press Analyse again` : '')}${stat('Positive', d.sentiment.positive)}${stat('Neutral', d.sentiment.neutral)}${stat('Negative', d.sentiment.negative)}
        ${stat('Needs attention', d.needsAttention.length)}${stat('Unanswered', d.unanswered.length)}${stat('Handled by AI', d.aiHandled)}
      </div>
      <div class="fb-grid">
        <section class="card fb-chart"><header class="card__head"><div><h2>Automatic replies</h2><p>${isAdmin() ? 'Only administrators can change these.' : 'Set by an administrator.'}</p></div></header>
          ${toggle('auto_reply_enabled', 'Reply automatically with AI', 'When feedback arrives, the AI drafts a reply. Complaints about money, accounts, legal, safety or security, low ratings and anything the AI is unsure about are never answered automatically: they are flagged for you instead.')}
          ${toggle('require_approval', 'An administrator must approve AI replies before they are sent', 'Recommended. Drafts wait below until someone approves, edits or discards them.')}
          ${toggle('status_emails_enabled', 'Email customers when their feedback is Under Review or Resolved', 'Sent once per status, never repeated.')}
          <p class="em-muted">Every automatic AI email tells the customer it was written by an AI assistant and that the team reads every message.${s.updated_by ? ` Last changed by ${esc(s.updated_by)} ${timeAgo(s.updated_at)}.` : ''}</p>
        </section>
        ${card('Categories found by the AI', '', d.analysed ? hbars(d.classification.map(c => ({ label: CLASSIFY[c.key], value: c.count }))) : '<p class="empty-chart">Nothing analysed yet.</p>')}
      </div>
      <section class="card"><header class="card__head"><div><h2>AI replies waiting for approval</h2><p>Nothing here is sent until someone approves it.</p></div></header>
        ${d.pendingApproval.length ? `<div class="fb-thread">${d.pendingApproval.map(p => `<div class="fb-thread__item"><div class="fb-thread__meta"><strong>${esc(p.reference)}</strong> · to ${esc(p.name || '')} &lt;${esc(p.email || '')}&gt; · ${timeAgo(p.created_at)}</div><p><strong>${esc(p.subject)}</strong></p><p>${esc(p.body)}</p>
          <div class="em-actions"><button type="button" class="btn btn--primary btn--sm" data-fb-approve="${esc(p.id)}">Approve and send</button><button type="button" class="btn btn--ghost btn--sm" data-fb-item="${esc(p.feedback_id)}">Open to edit</button><button type="button" class="btn btn--ghost btn--sm" data-fb-discard="${esc(p.id)}">Discard</button></div></div>`).join('')}</div>` : '<p class="em-muted">No AI replies are waiting.</p>'}
      </section>
      <section class="card"><header class="card__head"><div><h2>Needs attention</h2><p>Flagged for a person: sensitive subjects, low ratings, negative complaints, or what the AI could not handle safely.</p></div></header>
        ${list(d.needsAttention, 'Nothing needs attention right now.', r => (r.reason ? `<p class="fb-ai__warn">${esc(r.reason)}</p>` : ''))}</section>
      <section class="card"><header class="card__head"><div><h2>Unanswered feedback</h2><p>Open feedback nobody has replied to yet (the confirmation email does not count).</p></div></header>
        ${list(d.unanswered, 'Every open piece of feedback has a reply.')}</section>
      <section class="card"><header class="card__head"><div><h2>Awaiting the customer</h2><p>We asked for more information.</p></div></header>
        ${list(d.awaitingCustomer, 'Not waiting on any customer.')}</section>
      <section class="card"><header class="card__head"><div><h2>AI activity</h2><p>The latest 30 things the AI did, and who asked.</p></div></header>
        ${d.activity.length ? `<div class="table-card"><table class="table"><thead><tr><th>When</th><th>Feedback</th><th>Action</th><th>By</th><th>Result</th></tr></thead><tbody>${d.activity.map(l => `<tr><td data-label="When">${timeAgo(l.created_at)}</td><td data-label="Feedback">${l.feedback_id ? `<a href="#" data-fb-item="${esc(l.feedback_id)}">${esc(l.reference)}</a>` : '—'}</td><td data-label="Action">${esc(l.action.replace('compose:', 'write: ').replace(/_/g, ' '))}</td><td data-label="By">${esc(l.actor)}</td><td data-label="Result">${l.outcome === 'ok' ? '<span class="pill pill--green">Done</span>' : l.outcome === 'held' ? '<span class="pill pill--amber">Held for a person</span>' : '<span class="pill pill--red">Failed</span>'} ${esc(l.detail || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="em-muted">No AI activity yet.</p>'}
      </section>`;
  }

  // ---------- Events ----------
  document.getElementById('feedbackTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-fb-tab]'); if (b) setTab(b.dataset.fbTab); });
  root.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-fb-reload]')) return setTab(state.tab);
    const setting = t.closest('[data-fb-setting]');
    if (setting) {
      try { await api('/api/feedback-admin/ai/settings', { method: 'PUT', body: json({ [setting.dataset.fbSetting]: setting.checked }) }); toast('Saved.', 'success'); } catch (err) { setting.checked = !setting.checked; toast(err.message, 'error'); }
      return undefined;
    }
    const approve = t.closest('[data-fb-approve]');
    const discard = t.closest('[data-fb-discard]');
    if (approve || discard) {
      const btn = approve || discard;
      busy(btn, true);
      try {
        const r = await api(`/api/feedback-admin/emails/${btn.dataset.fbApprove || btn.dataset.fbDiscard}/${approve ? 'approve' : 'discard'}`, { method: 'POST', body: json({}) });
        toast(approve ? (r.email.status === 'sent' ? 'AI reply approved and sent.' : `The email failed: ${r.email.error}`) : 'Draft discarded. Nothing was sent.', approve && r.email.status !== 'sent' ? 'error' : 'success');
        loadAssistant().catch(showError);
      } catch (err) { toast(err.message, 'error'); busy(btn, false); }
      return undefined;
    }
    const row = t.closest('[data-fb-item]');
    if (row) { e.preventDefault(); return openItem(row.dataset.fbItem); }
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
    if (act) itemAction(act.dataset.fbAct, act.dataset.id, act);
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
