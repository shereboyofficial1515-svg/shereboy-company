// public/admin/email.js
// The Email Marketing center: overview, subscribers, compose, templates,
// campaigns and settings. All numbers come from the server. The server enforces
// who may do what; nothing here is a security boundary.
(function () {
  'use strict';
  const { api, json, esc, toast, confirmDialog, timeAgo, fmtDate, openDialog, closeDialog } = window.AdminKit;
  const root = document.getElementById('emailCenter');
  const modal = document.getElementById('emailModal');
  const modalBody = document.getElementById('emailModalBody');
  const modalTitle = document.getElementById('emailModalTitle');
  const q = (s, r = root) => r.querySelector(s);
  const qa = (s, r = root) => Array.from(r.querySelectorAll(s));

  const TABS = [['overview', 'Overview'], ['subscribers', 'Subscribers'], ['compose', 'Compose'], ['campaigns', 'Campaigns'], ['templates', 'Templates'], ['settings', 'Settings']];
  const state = { tab: 'overview', subs: { page: 1, status: '', search: '' }, campPage: 1, draft: null, pollTimer: null, templates: [] };

  const pillClass = { active: 'green', delivered: 'green', completed: 'green', pending: 'amber', scheduled: 'blue', queued: 'blue', sending: 'blue', draft: 'grey', cancelled: 'grey', unsubscribed: 'grey', suppressed: 'grey', accepted: 'blue', skipped: 'grey', bounced: 'red', complained: 'red', failed: 'red', delayed: 'amber' };
  const pill = (s) => `<span class="pill pill--${pillClass[s] || 'grey'}">${esc(s)}</span>`;
  const skeleton = () => '<div class="card"><span class="skeleton"></span><br><span class="skeleton"></span><br><span class="skeleton"></span></div>';

  function showError(target, err) {
    if (err.code === 'MIGRATION_REQUIRED') {
      target.innerHTML = `<div class="card em-notice"><h2>One step left: update the database</h2><p>Back up your database, then run <code>database/migrations/2026-11-02-email-marketing.sql</code> in the Supabase SQL Editor.</p></div>`;
      return;
    }
    target.innerHTML = `<div class="card em-notice"><p>${esc(err.message)}</p><button type="button" class="btn btn--ghost" data-em-reload>Try again</button></div>`;
  }

  function setTab(tab) {
    state.tab = TABS.some(t => t[0] === tab) ? tab : 'overview';
    clearTimeout(state.pollTimer);
    qa('[data-em-tab]', document.getElementById('emailTabs')).forEach(b => {
      const on = b.dataset.emTab === state.tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    ({ overview: loadOverview, subscribers: loadSubscribers, compose: loadCompose, campaigns: loadCampaigns, templates: loadTemplates, settings: loadSettings })[state.tab]();
  }

  // ---------- Overview ----------
  const stat = (label, value, hint) => `<div class="em-stat"><span class="em-stat__label">${esc(label)}</span><strong>${Number(value).toLocaleString()}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
  const check = (ok, label, detail) => `<li><span class="sys-dot sys-dot--${ok ? 'ok' : 'warn'}"></span><strong>${esc(label)}</strong><small>${esc(detail)}</small></li>`;

  function configList(c) {
    return `<ul class="sys-list">
      ${check(c.apiKeyConfigured, 'Resend API key', c.apiKeyConfigured ? 'Set on the server. It is never shown here.' : 'Not set: nothing can be sent until RESEND_API_KEY is added on the server.')}
      ${check(!!c.sender, 'Sender', c.sender || 'Not set: add RESEND_FROM_EMAIL on the server.')}
      ${check(c.webhookSecretConfigured, 'Delivery webhook', c.webhookSecretConfigured ? `Signing secret set. Endpoint: ${c.webhookUrl}` : `Not set: delivery stats stay empty until RESEND_WEBHOOK_SECRET is added. Endpoint: ${c.webhookUrl}`)}
      ${check(c.tokenSecretConfigured, 'Link signing', c.tokenSecretConfigured ? 'Set.' : 'Not set: unsubscribe links would stop working after a restart.')}
      ${check(true, 'Resend contacts', 'Kept in step when the API key has Full access. A sending-only key still sends everything.')}
      ${check(c.segmentConfigured, 'Resend segment', c.segmentConfigured ? 'Confirmed subscribers are added to your segment.' : 'Optional: confirmed subscribers are added as contacts with no segment.')}
    </ul>
    <p class="em-muted">This shows what is configured here. Whether your domain's SPF, DKIM and DMARC records pass is shown under Domains in your Resend dashboard.</p>`;
  }

  async function loadOverview() {
    root.innerHTML = skeleton();
    try {
      const d = await api('/api/email/overview');
      const s = d.subscribers; const m = d.messages;
      root.innerHTML = `
        <div class="em-stats">
          ${stat('Total subscribers', s.total)}${stat('Active', s.active, 'Confirmed by email')}${stat('Pending confirmation', s.pending)}${stat('Unsubscribed', s.unsubscribed)}
        </div>
        <div class="em-stats">
          ${stat('Campaigns sent', d.campaigns.sent)}${stat('Delivered', m.delivered, 'Confirmed by Resend webhook')}${stat('Accepted, awaiting result', m.awaitingConfirmation, 'Resend took it; delivery not yet confirmed')}${stat('Bounced', m.bounced)}${stat('Complaints', m.complaints)}${stat('Failed', m.failed)}
        </div>
        <section class="card"><header class="card__head"><div><h2>Setup</h2></div></header>${configList(d.config)}</section>`;
    } catch (err) { showError(root, err); }
  }

  // ---------- Subscribers ----------
  async function loadSubscribers() {
    const s = state.subs;
    root.innerHTML = `
      <div class="toolbar">
        <div class="toolbar__search"><input type="search" id="emSubSearch" placeholder="Search by email" aria-label="Search subscribers" value="${esc(s.search)}"></div>
        <select id="emSubStatus" aria-label="Filter by status">
          ${['', 'active', 'pending', 'unsubscribed', 'bounced', 'complained', 'suppressed'].map(v => `<option value="${v}" ${v === s.status ? 'selected' : ''}>${v ? v[0].toUpperCase() + v.slice(1) : 'All statuses'}</option>`).join('')}
        </select>
        <a class="btn btn--ghost" id="emSubExport" href="/api/email/subscribers/export.csv?status=${encodeURIComponent(s.status)}">Export CSV</a>
      </div>
      <div class="table-card"><table class="table"><thead><tr><th>Email</th><th>Status</th><th>Subscribed</th><th>Confirmed</th><th>Source</th><th>Last email activity</th></tr></thead><tbody id="emSubRows"><tr><td colspan="6"><span class="skeleton"></span></td></tr></tbody></table><div class="pager" id="emSubPager"></div></div>`;
    let t;
    q('#emSubSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { s.search = e.target.value.trim(); s.page = 1; fillSubscribers(); }, 300); });
    q('#emSubStatus').addEventListener('change', (e) => { s.status = e.target.value; s.page = 1; q('#emSubExport').href = `/api/email/subscribers/export.csv?status=${encodeURIComponent(s.status)}`; fillSubscribers(); });
    fillSubscribers();
  }

  async function fillSubscribers() {
    const s = state.subs;
    const rows = q('#emSubRows');
    try {
      const d = await api(`/api/email/subscribers?page=${s.page}&limit=25&status=${encodeURIComponent(s.status)}&search=${encodeURIComponent(s.search)}`);
      rows.innerHTML = d.subscribers.length ? d.subscribers.map(x => `<tr class="em-row" data-em-sub="${esc(x.id)}" tabindex="0">
        <td data-label="Email"><strong>${esc(x.email)}</strong></td>
        <td data-label="Status">${pill(x.status)}</td>
        <td data-label="Subscribed">${fmtDate(x.created_at)}</td>
        <td data-label="Confirmed">${x.confirmed_at ? fmtDate(x.confirmed_at) : '—'}</td>
        <td data-label="Source">${esc(x.signup_source || '—')}</td>
        <td data-label="Last email activity">${x.last_email_at ? `${esc(x.last_event || 'sent')} · ${timeAgo(x.last_email_at)}` : '—'}</td></tr>`).join('')
        : '<tr><td colspan="6" class="table-empty">No subscribers match. People appear here after using the form on your website.</td></tr>';
      const pages = Math.ceil(d.total / 25);
      q('#emSubPager').innerHTML = pages > 1 ? `<span>Page ${s.page} of ${pages} · ${d.total} people</span><div>
        <button type="button" class="btn btn--ghost btn--sm" data-em-subpage="-1" ${s.page <= 1 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn--ghost btn--sm" data-em-subpage="1" ${s.page >= pages ? 'disabled' : ''}>Next</button></div>` : `<span>${d.total} ${d.total === 1 ? 'person' : 'people'}</span>`;
    } catch (err) {
      if (err.code === 'MIGRATION_REQUIRED') return showError(root, err);
      rows.innerHTML = `<tr><td colspan="6" class="table-empty">${esc(err.message)}</td></tr>`;
    }
  }

  async function openSubscriber(id) {
    try {
      const d = await api(`/api/email/subscribers/${id}`);
      const x = d.subscriber;
      modalTitle.textContent = x.email;
      const kv = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '');
      const canStop = ['active', 'pending'].includes(x.status);
      modalBody.innerHTML = `
        <dl class="sys-kv">
          <dt>Status</dt><dd>${pill(x.status)}</dd>
          ${kv('Name', x.first_name)}${kv('Consent', x.consent_status)}${kv('Consent recorded', x.consent_timestamp && new Date(x.consent_timestamp).toLocaleString('en-GB'))}${kv('Consent wording', x.consent_text)}${kv('Source', x.signup_source)}
          ${kv('Unsubscribed', x.unsubscribed_at && `${new Date(x.unsubscribed_at).toLocaleString('en-GB')} (${x.unsubscribe_source || 'unknown'})`)}
          ${d.suppression ? `<dt>Suppressed</dt><dd>${esc(d.suppression.reason)}: this address won't be emailed.</dd>` : ''}
        </dl>
        <h3 class="em-subhead">Recent activity</h3>
        ${d.events.length ? `<ul class="sys-list">${d.events.map(e => `<li><span class="sys-dot"></span><strong>${esc(e.type.replace(/^(email|local)\./, ''))}</strong><small>${timeAgo(e.occurred_at)}${e.detail ? ` · ${esc(e.detail)}` : ''}</small></li>`).join('')}</ul>` : '<p class="em-muted">No activity recorded yet.</p>'}
        <p class="em-muted">Someone who has opted out can only come back through their own confirmed request.</p>
        <div class="em-actions">
          ${canStop ? `<button type="button" class="btn btn--ghost" data-em-subact="unsubscribe" data-id="${esc(x.id)}">Unsubscribe them</button><button type="button" class="btn btn--ghost" data-em-subact="suppress" data-id="${esc(x.id)}">Suppress</button>` : ''}
          <button type="button" class="btn btn--danger" data-em-subact="remove" data-id="${esc(x.id)}">Remove record</button>
        </div>`;
      openDialog(modal);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function subscriberAction(act, id) {
    const copy = {
      unsubscribe: ['Unsubscribe this person?', 'They will stop receiving marketing email. Do this when they have asked you to.', 'Unsubscribe'],
      suppress: ['Suppress this address?', 'It will no longer receive any email from this system.', 'Suppress'],
      remove: ['Remove this record?', 'Their details are deleted, and the address stays on the do-not-email list.', 'Remove']
    }[act];
    if (!await confirmDialog({ title: copy[0], text: copy[1], ok: copy[2] })) return;
    try {
      if (act === 'remove') await api(`/api/email/subscribers/${id}`, { method: 'DELETE' });
      else await api(`/api/email/subscribers/${id}/${act}`, { method: 'POST' });
      closeDialog(modal);
      toast('Done.', 'success');
      fillSubscribers();
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---------- Rich text editor ----------
  const ICON_BTNS = [
    ['h2', 'Heading'], ['h3', 'Subheading'], ['p', 'Paragraph'], ['bold', 'B'], ['italic', 'I'],
    ['ul', '• List'], ['ol', '1. List'], ['link', 'Link'], ['image', 'Image'], ['button', 'Button'], ['hr', 'Divider']
  ];

  /** A small editor. The server sanitizes everything it receives from here. */
  function createEditor(mount, initialHtml) {
    mount.innerHTML = `
      <div class="em-editor">
        <div class="em-editor__bar" role="toolbar" aria-label="Formatting">
          ${ICON_BTNS.map(([k, l]) => `<button type="button" data-cmd="${k}" class="em-tool em-tool--${k}">${l}</button>`).join('')}
          <button type="button" data-cmd="source" class="em-tool em-tool--source" aria-pressed="false">HTML</button>
        </div>
        <div class="em-editor__ask" hidden></div>
        <div class="em-editor__area" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Email content"></div>
        <textarea class="em-editor__source" aria-label="Email HTML source" spellcheck="false" hidden></textarea>
      </div>`;
    const area = q('.em-editor__area', mount);
    const source = q('.em-editor__source', mount);
    const ask = q('.em-editor__ask', mount);
    area.innerHTML = initialHtml || '<p><br></p>';
    let saved = null;

    const remember = () => {
      const sel = window.getSelection();
      if (sel.rangeCount && area.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
    };
    const restore = () => {
      area.focus();
      if (saved) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(saved); }
    };
    area.addEventListener('keyup', remember);
    area.addEventListener('mouseup', remember);
    area.addEventListener('blur', remember);
    // Pasting from elsewhere brings plain text, not hidden formatting
    area.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
    });

    function askFor(fields, submit) {
      ask.hidden = false;
      ask.innerHTML = `${fields.map(f => `<label>${esc(f.label)}<input type="${f.type || 'text'}" data-k="${f.k}" value="${esc(f.value || '')}" ${f.accept ? `accept="${f.accept}"` : ''} placeholder="${esc(f.placeholder || '')}"></label>`).join('')}
        <div class="em-actions"><button type="button" class="btn btn--primary btn--sm" data-ok>Insert</button><button type="button" class="btn btn--ghost btn--sm" data-no>Cancel</button></div>`;
      const close = () => { ask.hidden = true; ask.innerHTML = ''; };
      q('[data-no]', ask).addEventListener('click', close);
      q('[data-ok]', ask).addEventListener('click', async () => {
        const values = {};
        qa('[data-k]', ask).forEach(i => { values[i.dataset.k] = i.type === 'file' ? i.files[0] : i.value.trim(); });
        const message = await submit(values);
        if (message) { toast(message, 'error'); return; }
        close();
      });
      q('input', ask).focus();
    }
    const validLink = (u) => /^(https?:\/\/\S+|mailto:\S+|tel:\S+)$/i.test(u);
    const insert = (html) => { restore(); document.execCommand('insertHTML', false, html); remember(); };

    q('.em-editor__bar', mount).addEventListener('mousedown', (e) => { if (e.target.closest('[data-cmd]')) e.preventDefault(); });
    q('.em-editor__bar', mount).addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      const cmd = b.dataset.cmd;
      if (cmd === 'source') {
        const on = source.hidden;
        if (on) { source.value = area.innerHTML; } else { area.innerHTML = source.value; }
        source.hidden = !on; area.hidden = on;
        b.setAttribute('aria-pressed', String(on));
        qa('[data-cmd]', mount).forEach(x => { if (x !== b) x.disabled = on; });
        return;
      }
      restore();
      if (['h2', 'h3', 'p'].includes(cmd)) document.execCommand('formatBlock', false, cmd);
      if (cmd === 'bold' || cmd === 'italic') document.execCommand(cmd);
      if (cmd === 'ul') document.execCommand('insertUnorderedList');
      if (cmd === 'ol') document.execCommand('insertOrderedList');
      if (cmd === 'hr') document.execCommand('insertHorizontalRule');
      if (cmd === 'link') {
        const label = window.getSelection().toString();
        askFor([{ k: 'url', label: 'Web address', placeholder: 'https://', value: 'https://' }, ...(label ? [] : [{ k: 'text', label: 'Link text' }])], ({ url, text }) => {
          if (!validLink(url)) return 'Enter a full web address, starting with https://';
          if (label) { restore(); document.execCommand('createLink', false, url); } else insert(`<a href="${esc(url)}">${esc(text || url)}</a>`);
          return null;
        });
      }
      if (cmd === 'button') {
        askFor([{ k: 'text', label: 'Button text', value: 'Learn more' }, { k: 'url', label: 'Web address', value: 'https://' }], ({ text, url }) => {
          if (!validLink(url) || !text) return 'Enter button text and a full web address.';
          insert(`<p><a class="email-btn" href="${esc(url)}">${esc(text)}</a></p><p><br></p>`);
          return null;
        });
      }
      if (cmd === 'image') {
        askFor([{ k: 'file', label: 'Upload an image', type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif' }, { k: 'url', label: 'Or use a web address', placeholder: 'https://' }, { k: 'alt', label: 'Description (alt text)' }], async ({ file, url, alt }) => {
          let src = url;
          if (file) {
            const fd = new FormData();
            fd.append('file', file);
            fd.append('folder', 'email');
            try { src = (await api('/api/upload', { method: 'POST', body: fd })).url; } catch (err) { return err.message; }
          }
          if (!/^https:\/\/\S+$/i.test(src)) return 'Images must be uploaded, or use a full https:// address.';
          insert(`<img src="${esc(src)}" alt="${esc(alt)}">`);
          return null;
        });
      }
      remember();
    });
    return {
      get: () => (source.hidden ? area.innerHTML : source.value),
      set: (html) => { area.innerHTML = html || '<p><br></p>'; source.value = html || ''; }
    };
  }

  // ---------- Preview ----------
  async function showPreview({ subject, preheader, body_html, mode }) {
    try {
      const { html } = await api('/api/email/preview', { method: 'POST', body: json({ subject, preheader, body_html, mode }) });
      modalTitle.textContent = subject || 'Preview';
      modalBody.innerHTML = `
        <div class="segmented" role="group" aria-label="Preview size"><button type="button" class="is-active" data-em-pv="100%">Desktop</button><button type="button" data-em-pv="375px">Mobile</button></div>
        <p class="em-muted">Shown with an example first name. Scripts are disabled in this preview.</p>
        <div class="em-preview"><iframe id="emPreviewFrame" title="Email preview" sandbox=""></iframe></div>`;
      q('#emPreviewFrame', modalBody).srcdoc = html;
      openDialog(modal);
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---------- Compose ----------
  const blankDraft = () => ({ id: null, mode: 'newsletter', name: '', subject: '', preheader: '', reply_to: '', body_html: '', audience: { sources: [], confirmedAfter: null, emails: [] } });

  async function loadCompose() {
    const d = state.draft || (state.draft = blankDraft());
    root.innerHTML = skeleton();
    let sources = []; let templates = [];
    try {
      [{ sources }, { templates }] = await Promise.all([api('/api/email/segments'), api('/api/email/templates')]);
      state.templates = templates;
    } catch (err) { return showError(root, err); }
    root.innerHTML = `
      <div class="em-compose">
        <section class="card em-compose__main">
          <div class="segmented" role="group" aria-label="Sending mode">
            <button type="button" data-em-mode="newsletter" class="${d.mode === 'newsletter' ? 'is-active' : ''}">Newsletter campaign</button>
            <button type="button" data-em-mode="individual" class="${d.mode === 'individual' ? 'is-active' : ''}">Individual email</button>
          </div>
          <div class="field"><label for="emTemplate">Start from a template</label><select id="emTemplate"><option value="">Choose a template…</option>${templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="emName">Campaign name (internal)</label><input id="emName" maxlength="150" value="${esc(d.name)}"></div>
          <div class="field"><label for="emSubject">Subject</label><input id="emSubject" maxlength="200" value="${esc(d.subject)}"></div>
          <div class="field"><label for="emPreheader">Inbox preview text</label><input id="emPreheader" maxlength="200" value="${esc(d.preheader || '')}"><p class="field__hint">The short line shown after the subject in most inboxes.</p></div>
          <div class="field"><span class="field__label">Email content</span><div id="emEditor"></div><p class="field__hint">Write <code>{{first_name}}</code> to use the subscriber's name, when we have it. The unsubscribe link and company footer are added automatically.</p></div>
        </section>
        <aside class="em-compose__side">
          <section class="card"><header class="card__head"><div><h2>Recipients</h2></div></header><div id="emAudience"></div></section>
          <section class="card"><header class="card__head"><div><h2>Sender</h2></div></header>
            <p class="em-muted">Always sent from your verified company address.</p>
            <div class="field"><label for="emReplyTo">Reply-to (optional)</label><input id="emReplyTo" type="email" value="${esc(d.reply_to || '')}"></div>
          </section>
          <section class="card"><header class="card__head"><div><h2>Send</h2></div></header>
            <div class="em-actions"><button type="button" class="btn btn--ghost" id="emSave">Save draft</button><button type="button" class="btn btn--ghost" id="emPreview">Preview</button></div>
            <div class="field"><label for="emTestTo">Send a test to</label><input id="emTestTo" type="email" placeholder="you@example.com"></div>
            <button type="button" class="btn btn--ghost" id="emTest">Send test email</button>
            <div class="field"><label for="emWhen">Schedule for later (optional)</label><input id="emWhen" type="datetime-local"></div>
            <button type="button" class="btn btn--ghost" id="emSchedule">Schedule</button>
            <button type="button" class="btn btn--primary btn--block" id="emSend">Send now</button>
          </section>
        </aside>
      </div>`;
    const editor = createEditor(q('#emEditor'), d.body_html);

    function renderAudience() {
      const box = q('#emAudience');
      if (d.mode === 'individual') {
        box.innerHTML = `<div class="field"><label for="emTo">Email addresses</label><textarea id="emTo" rows="3" placeholder="one@gmail.com, two@outlook.com">${esc((d.audience.emails || []).join(', '))}</textarea><p class="field__hint">For people who expect this message, such as a client you are working with. Not for bulk or cold email.</p></div>
          <label class="em-check"><input type="checkbox" id="emAck"> These people know us and expect to hear from us.</label>`;
      } else {
        box.innerHTML = `<p class="em-muted">Only people who confirmed their subscription, minus anyone who has opted out.</p>
          ${sources.length ? `<fieldset class="em-fieldset"><legend>Signed up from (leave empty for all)</legend>${sources.map(s => `<label class="em-check"><input type="checkbox" data-em-src value="${esc(s.source)}" ${(d.audience.sources || []).includes(s.source) ? 'checked' : ''}> ${esc(s.source)} (${s.count})</label>`).join('')}</fieldset>` : '<p class="em-muted">No confirmed subscribers yet.</p>'}
          <div class="field"><label for="emAfter">Confirmed on or after (optional)</label><input id="emAfter" type="date" value="${d.audience.confirmedAfter ? String(d.audience.confirmedAfter).slice(0, 10) : ''}"></div>`;
      }
    }
    renderAudience();

    function collect() {
      d.name = q('#emName').value.trim();
      d.subject = q('#emSubject').value.trim();
      d.preheader = q('#emPreheader').value.trim();
      d.reply_to = q('#emReplyTo').value.trim();
      d.body_html = editor.get();
      if (d.mode === 'individual') {
        d.audience = { sources: [], confirmedAfter: null, emails: (q('#emTo').value || '').split(/[\s,;]+/).filter(Boolean) };
      } else {
        const after = q('#emAfter') && q('#emAfter').value;
        d.audience = { sources: qa('[data-em-src]:checked').map(c => c.value), confirmedAfter: after ? new Date(after).toISOString() : null, emails: [] };
      }
      return { name: d.name, subject: d.subject, preheader: d.preheader, reply_to: d.reply_to, body_html: d.body_html, mode: d.mode, audience: d.audience };
    }

    async function save() {
      const payload = collect();
      const res = d.id
        ? await api(`/api/email/campaigns/${d.id}`, { method: 'PUT', body: json(payload) })
        : await api('/api/email/campaigns', { method: 'POST', body: json(payload) });
      d.id = res.campaign.id;
      d.name = res.campaign.name;
      q('#emName').value = d.name;
      return res.campaign;
    }

    qa('[data-em-mode]').forEach(b => b.addEventListener('click', () => {
      collect();
      d.mode = b.dataset.emMode;
      qa('[data-em-mode]').forEach(x => x.classList.toggle('is-active', x === b));
      renderAudience();
    }));
    q('#emTemplate').addEventListener('change', (e) => {
      const t = templates.find(x => x.id === e.target.value);
      if (!t) return;
      if (t.subject) q('#emSubject').value = t.subject;
      q('#emPreheader').value = t.preheader || '';
      if (!q('#emName').value) q('#emName').value = t.name;
      editor.set(t.body_html);
    });
    q('#emSave').addEventListener('click', async () => {
      try { await save(); toast('Draft saved.', 'success'); } catch (err) { toast(err.message, 'error'); }
    });
    q('#emPreview').addEventListener('click', () => showPreview(collect()));
    q('#emTest').addEventListener('click', async () => {
      const to = q('#emTestTo').value.trim();
      if (!to) { toast('Enter an address for the test.', 'error'); return; }
      try {
        const p = collect();
        const r = await api('/api/email/test', { method: 'POST', body: json({ to, subject: p.subject, preheader: p.preheader, body_html: p.body_html, reply_to: p.reply_to }) });
        toast(r.note, 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    async function release(path, extra) {
      const ack = q('#emAck');
      const camp = await save();
      const est = await api(`/api/email/campaigns/${camp.id}/estimate`);
      if (!est.count) throw new Error(d.mode === 'individual' ? 'None of these addresses can be emailed.' : 'No confirmed subscribers match this audience.');
      const verb = path === 'schedule' ? 'Schedule' : 'Send';
      const skipped = est.blocked.length ? ` ${est.blocked.length} address(es) have opted out and will be skipped.` : '';
      const body = { ...extra, acknowledged: !!(ack && ack.checked) };
      if (est.confirmRequired) {
        const typed = await askCount(est.count, verb);
        if (typed === null) return false;
        body.confirmCount = typed;
      } else if (!await confirmDialog({ title: `${verb} to ${est.count} ${est.count === 1 ? 'person' : 'people'}?`, text: `"${d.subject}" can't be recalled once sent.${skipped}`, ok: verb })) {
        return false;
      }
      try {
        await api(`/api/email/campaigns/${camp.id}/${path}`, { method: 'POST', body: json(body) });
      } catch (err) {
        if (err.code !== 'POSSIBLE_DUPLICATE') throw err;
        if (!await confirmDialog({ title: 'Send this again?', text: err.message, ok: 'Send again' })) return false;
        await api(`/api/email/campaigns/${camp.id}/${path}`, { method: 'POST', body: json({ ...body, allowRepeat: true }) });
      }
      return true;
    }
    q('#emSend').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        if (await release('send', {})) {
          toast('Queued. Sending runs in the background.', 'success');
          state.draft = null;
          setTab('campaigns');
        }
      } catch (err) { toast(err.message, 'error'); } finally { e.target.disabled = false; }
    });
    q('#emSchedule').addEventListener('click', async () => {
      const when = q('#emWhen').value;
      if (!when) { toast('Choose a date and time first.', 'error'); return; }
      try {
        if (await release('schedule', { scheduled_at: new Date(when).toISOString() })) {
          toast('Scheduled.', 'success');
          state.draft = null;
          setTab('campaigns');
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  /** Large sends: typing the number proves the size was noticed. */
  function askCount(count, verb) {
    return new Promise((resolve) => {
      modalTitle.textContent = `${verb} to ${count.toLocaleString()} people?`;
      modalBody.innerHTML = `<p>This can't be recalled. Type <strong>${count}</strong> to confirm.</p>
        <div class="field"><label for="emCount">Number of recipients</label><input id="emCount" inputmode="numeric" autocomplete="off"></div>
        <div class="em-actions"><button type="button" class="btn btn--primary" id="emCountOk" disabled>${esc(verb)}</button></div>`;
      let answered = false;
      const input = q('#emCount', modalBody);
      const ok = q('#emCountOk', modalBody);
      input.addEventListener('input', () => { ok.disabled = Number(input.value) !== count; });
      ok.addEventListener('click', () => { answered = true; closeDialog(modal); resolve(count); });
      openDialog(modal, () => { if (!answered) resolve(null); });
    });
  }

  // ---------- Campaigns ----------
  const audienceLabel = (c) => {
    if (c.mode === 'individual') return `Individual (${(c.audience.emails || []).length})`;
    const s = c.audience.sources || [];
    return s.length ? `Subscribers: ${s.join(', ')}` : 'All confirmed subscribers';
  };
  const statsCell = (c) => {
    const s = c.stats || {};
    if (!s.total) return '—';
    return `${s.accepted_total || 0} accepted · ${s.delivered || 0} delivered${s.bounced ? ` · ${s.bounced} bounced` : ''}${s.failed ? ` · ${s.failed} failed` : ''}`;
  };

  async function loadCampaigns() {
    root.innerHTML = `<div class="toolbar"><button type="button" class="btn btn--primary" data-em-new>New campaign</button></div>
      <div class="table-card"><table class="table"><thead><tr><th>Campaign</th><th>Subject</th><th>Audience</th><th>Status</th><th>Scheduled</th><th>Sent</th><th>Delivery</th></tr></thead><tbody id="emCampRows"><tr><td colspan="7"><span class="skeleton"></span></td></tr></tbody></table><div class="pager" id="emCampPager"></div></div>`;
    fillCampaigns();
  }

  async function fillCampaigns() {
    try {
      const d = await api(`/api/email/campaigns?page=${state.campPage}&limit=20`);
      const rows = q('#emCampRows');
      if (!rows) return;
      rows.innerHTML = d.campaigns.length ? d.campaigns.map(c => `<tr class="em-row" data-em-camp="${esc(c.id)}" tabindex="0">
        <td data-label="Campaign"><strong>${esc(c.name)}</strong></td><td data-label="Subject">${esc(c.subject)}</td>
        <td data-label="Audience">${esc(audienceLabel(c))}</td><td data-label="Status">${pill(c.status)}</td>
        <td data-label="Scheduled">${c.scheduled_at ? new Date(c.scheduled_at).toLocaleString('en-GB') : '—'}</td>
        <td data-label="Sent">${c.started_at ? new Date(c.started_at).toLocaleString('en-GB') : '—'}</td>
        <td data-label="Delivery">${esc(statsCell(c))}</td></tr>`).join('')
        : '<tr><td colspan="7" class="table-empty">No campaigns yet.</td></tr>';
      const pages = Math.ceil(d.total / 20);
      q('#emCampPager').innerHTML = pages > 1 ? `<span>Page ${state.campPage} of ${pages}</span><div>
        <button type="button" class="btn btn--ghost btn--sm" data-em-camppage="-1" ${state.campPage <= 1 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn--ghost btn--sm" data-em-camppage="1" ${state.campPage >= pages ? 'disabled' : ''}>Next</button></div>` : '';
      clearTimeout(state.pollTimer);
      if (state.tab === 'campaigns' && d.campaigns.some(c => ['queued', 'sending'].includes(c.status))) state.pollTimer = setTimeout(fillCampaigns, 5000);
    } catch (err) { showError(root, err); }
  }

  async function openCampaign(id) {
    try {
      const { campaign: c, stats: s, problems } = await api(`/api/email/campaigns/${id}`);
      modalTitle.textContent = c.name;
      const n = (label, value, hint) => `<div class="em-stat"><span class="em-stat__label">${esc(label)}</span><strong>${value}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
      modalBody.innerHTML = `
        <dl class="sys-kv"><dt>Status</dt><dd>${pill(c.status)}</dd><dt>Subject</dt><dd>${esc(c.subject)}</dd><dt>Audience</dt><dd>${esc(audienceLabel(c))}</dd>
        ${c.scheduled_at ? `<dt>Scheduled</dt><dd>${new Date(c.scheduled_at).toLocaleString('en-GB')}</dd>` : ''}
        ${c.started_at ? `<dt>Started</dt><dd>${new Date(c.started_at).toLocaleString('en-GB')}</dd>` : ''}
        ${c.completed_at ? `<dt>Finished</dt><dd>${new Date(c.completed_at).toLocaleString('en-GB')}</dd>` : ''}
        ${c.last_error ? `<dt>Note</dt><dd>${esc(c.last_error)}</dd>` : ''}</dl>
        <div class="em-stats em-stats--tight">
          ${n('Recipients', s.total)}${n('Accepted', s.accepted_total, 'Resend took it')}${n('Delivered', s.delivered, 'Confirmed by webhook')}${n('Bounced', s.bounced)}${n('Complaints', s.complained)}${n('Failed', s.failed)}${n('Skipped', s.skipped, 'Opted out before sending')}${n('Opened', s.opened)}${n('Clicked', s.clicked)}
        </div>
        <p class="em-muted">Accepted means Resend took the message, not that it arrived. Opens and clicks are incomplete, because many mail apps block or pre-load tracking.</p>
        ${problems.length ? `<h3 class="em-subhead">Problems</h3><ul class="sys-list">${problems.map(p => `<li><span class="sys-dot sys-dot--${p.status === 'skipped' ? '' : 'bad'}"></span><strong>${esc(p.email)}</strong><small>${esc(p.status)}${p.last_error ? ` · ${esc(p.last_error)}` : ''}</small></li>`).join('')}</ul>` : ''}
        <div class="em-actions">
          ${c.status === 'draft' ? `<button type="button" class="btn btn--primary" data-em-camp-act="edit" data-id="${c.id}">Edit</button><button type="button" class="btn btn--danger" data-em-camp-act="delete" data-id="${c.id}">Delete</button>` : ''}
          ${['scheduled', 'queued', 'sending'].includes(c.status) ? `<button type="button" class="btn btn--danger" data-em-camp-act="cancel" data-id="${c.id}">Cancel</button>` : ''}
          ${c.status === 'failed' ? `<button type="button" class="btn btn--primary" data-em-camp-act="resume" data-id="${c.id}">Resume</button>` : ''}
          <button type="button" class="btn btn--ghost" data-em-camp-act="preview" data-id="${c.id}">View email</button>
          <button type="button" class="btn btn--ghost" data-em-camp-act="duplicate" data-id="${c.id}">Copy to new draft</button>
        </div>`;
      state.viewing = c;
      openDialog(modal);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function campaignAction(act, id) {
    const c = state.viewing;
    try {
      if (act === 'edit') {
        closeDialog(modal);
        state.draft = { id: c.id, mode: c.mode, name: c.name, subject: c.subject, preheader: c.preheader, reply_to: c.reply_to, body_html: c.body_html, audience: c.audience };
        setTab('compose');
      } else if (act === 'preview') {
        closeDialog(modal);
        showPreview({ subject: c.subject, preheader: c.preheader, body_html: c.body_html, mode: c.mode });
      } else if (act === 'delete') {
        if (!await confirmDialog({ title: 'Delete this draft?', text: c.name })) return;
        await api(`/api/email/campaigns/${id}`, { method: 'DELETE' });
        closeDialog(modal); fillCampaigns();
      } else if (act === 'cancel') {
        if (!await confirmDialog({ title: 'Cancel this campaign?', text: 'Emails already accepted by Resend can\'t be recalled. The rest won\'t be sent.', ok: 'Cancel campaign' })) return;
        await api(`/api/email/campaigns/${id}/cancel`, { method: 'POST' });
        closeDialog(modal); fillCampaigns();
      } else if (act === 'resume') {
        await api(`/api/email/campaigns/${id}/resume`, { method: 'POST' });
        closeDialog(modal); fillCampaigns();
      } else if (act === 'duplicate') {
        const { campaign } = await api(`/api/email/campaigns/${id}/duplicate`, { method: 'POST' });
        closeDialog(modal);
        state.draft = { id: campaign.id, mode: campaign.mode, name: campaign.name, subject: campaign.subject, preheader: campaign.preheader, reply_to: campaign.reply_to, body_html: campaign.body_html, audience: campaign.audience };
        setTab('compose');
      }
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---------- Templates ----------
  async function loadTemplates() {
    root.innerHTML = skeleton();
    try {
      const { templates } = await api('/api/email/templates');
      state.templates = templates;
      root.innerHTML = `<div class="toolbar"><button type="button" class="btn btn--primary" data-em-tpl-new>New template</button></div>
        <div class="em-tpl-grid">${templates.map(t => `<article class="card em-tpl">
          <span class="pill pill--grey">${esc(t.category || 'General')}</span>
          <h3>${esc(t.name)}</h3><p class="em-muted">${esc(t.subject)}</p>
          <div class="em-actions"><button type="button" class="btn btn--primary btn--sm" data-em-tpl-use="${esc(t.id)}">Use</button><button type="button" class="btn btn--ghost btn--sm" data-em-tpl-edit="${esc(t.id)}">Edit</button><button type="button" class="btn btn--ghost btn--sm" data-em-tpl-del="${esc(t.id)}">Delete</button></div>
        </article>`).join('')}</div>`;
    } catch (err) { showError(root, err); }
  }

  function editTemplate(t) {
    modalTitle.textContent = t ? `Edit: ${t.name}` : 'New template';
    modalBody.innerHTML = `
      <div class="field"><label for="tplName">Name</label><input id="tplName" value="${esc(t ? t.name : '')}"></div>
      <div class="field"><label for="tplCat">Category</label><input id="tplCat" value="${esc(t ? t.category || '' : '')}"></div>
      <div class="field"><label for="tplSubject">Subject</label><input id="tplSubject" value="${esc(t ? t.subject : '')}"></div>
      <div class="field"><label for="tplPre">Inbox preview text</label><input id="tplPre" value="${esc(t ? t.preheader || '' : '')}"></div>
      <div class="field"><span class="field__label">Content</span><div id="tplEditor"></div></div>
      <div class="em-actions"><button type="button" class="btn btn--primary" id="tplSave">Save template</button><button type="button" class="btn btn--ghost" id="tplPreview">Preview</button></div>`;
    const editor = createEditor(q('#tplEditor', modalBody), t ? t.body_html : '');
    const values = () => ({ name: q('#tplName', modalBody).value, category: q('#tplCat', modalBody).value, subject: q('#tplSubject', modalBody).value, preheader: q('#tplPre', modalBody).value, body_html: editor.get() });
    q('#tplPreview', modalBody).addEventListener('click', async () => {
      const v = values();
      try {
        const { html } = await api('/api/email/preview', { method: 'POST', body: json(v) });
        const win = q('#tplPreviewFrame', modalBody) || (() => { const f = document.createElement('iframe'); f.id = 'tplPreviewFrame'; f.title = 'Template preview'; f.setAttribute('sandbox', ''); f.className = 'em-preview__frame'; modalBody.appendChild(f); return f; })();
        win.srcdoc = html;
      } catch (err) { toast(err.message, 'error'); }
    });
    q('#tplSave', modalBody).addEventListener('click', async () => {
      try {
        if (t) await api(`/api/email/templates/${t.id}`, { method: 'PUT', body: json(values()) });
        else await api('/api/email/templates', { method: 'POST', body: json(values()) });
        closeDialog(modal);
        toast('Template saved.', 'success');
        loadTemplates();
      } catch (err) { toast(err.message, 'error'); }
    });
    openDialog(modal);
  }

  // ---------- Settings ----------
  const S_FIELDS = [
    ['sender_name', 'Sender name', 'text'], ['sender_email', 'Sender email', 'email', 'Must use your verified domain. Leave empty to use RESEND_FROM_EMAIL.'], ['reply_to', 'Reply-to email', 'email'],
    ['newsletter_description', 'Newsletter description', 'textarea'],
    ['confirmation_subject', 'Confirmation email subject', 'text'], ['confirmation_intro', 'Confirmation email message', 'textarea'], ['confirmation_expiry_hours', 'Confirmation link lasts (hours)', 'number', '1 to 168.'],
    ['welcome_subject', 'Welcome email subject', 'text'], ['welcome_body', 'Welcome email content (HTML)', 'textarea'],
    ['footer_text', 'Email footer', 'text'], ['logo_url', 'Company logo', 'url', 'A full https:// image address, around 80px tall. Leave empty to use your company name.'],
    ['contact_address', 'Company address', 'text'], ['contact_email', 'Company contact email', 'email'], ['contact_phone', 'Company phone', 'text']
  ];

  async function loadSettings() {
    root.innerHTML = skeleton();
    try {
      const { settings, config } = await api('/api/email/settings');
      root.innerHTML = `<div class="em-compose">
        <form class="card em-compose__main" id="emSettingsForm" novalidate>
          ${S_FIELDS.map(([k, label, type, hint]) => `<div class="field"><label for="es_${k}">${esc(label)}</label>${type === 'textarea'
    ? `<textarea id="es_${k}" rows="3">${esc(settings[k])}</textarea>`
    : `<input id="es_${k}" type="${type}" value="${esc(settings[k])}">`}${hint ? `<p class="field__hint">${esc(hint)}</p>` : ''}</div>`).join('')}
          <label class="em-check"><input type="checkbox" id="es_welcome_enabled" ${settings.welcome_enabled ? 'checked' : ''}> Send a welcome email after someone confirms</label>
          <p class="em-muted"><strong>Confirmation:</strong> every new subscriber must confirm by email before receiving anything. This can't be turned off.</p>
          <div class="em-actions"><button type="submit" class="btn btn--primary">Save settings</button></div>
        </form>
        <aside class="em-compose__side"><section class="card"><header class="card__head"><div><h2>Server configuration</h2><p>API keys stay on the server and can't be viewed or changed here.</p></div></header>${configList(config)}</section></aside>
      </div>`;
      q('#emSettingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {};
        S_FIELDS.forEach(([k]) => { body[k] = q(`#es_${k}`).value.trim(); });
        body.welcome_enabled = q('#es_welcome_enabled').checked;
        try {
          await api('/api/email/settings', { method: 'PUT', body: json(body) });
          toast('Settings saved.', 'success');
        } catch (err) { toast(err.message, 'error'); }
      });
    } catch (err) { showError(root, err); }
  }

  // ---------- Events ----------
  document.getElementById('emailTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-em-tab]'); if (b) setTab(b.dataset.emTab); });

  function rootClick(e) {
    const t = e.target;
    if (t.closest('[data-em-reload]')) return setTab(state.tab);
    const sub = t.closest('[data-em-sub]');
    if (sub) return openSubscriber(sub.dataset.emSub);
    const camp = t.closest('[data-em-camp]');
    if (camp) return openCampaign(camp.dataset.emCamp);
    if (t.closest('[data-em-new]')) { state.draft = null; return setTab('compose'); }
    const sp = t.closest('[data-em-subpage]');
    if (sp) { state.subs.page += Number(sp.dataset.emSubpage); return fillSubscribers(); }
    const cp = t.closest('[data-em-camppage]');
    if (cp) { state.campPage += Number(cp.dataset.emCamppage); return fillCampaigns(); }
    if (t.closest('[data-em-tpl-new]')) return editTemplate(null);
    const use = t.closest('[data-em-tpl-use]');
    if (use) {
      const tpl = state.templates.find(x => x.id === use.dataset.emTplUse);
      state.draft = { ...blankDraft(), name: tpl.name, subject: tpl.subject, preheader: tpl.preheader, body_html: tpl.body_html };
      return setTab('compose');
    }
    const edit = t.closest('[data-em-tpl-edit]');
    if (edit) return editTemplate(state.templates.find(x => x.id === edit.dataset.emTplEdit));
    const del = t.closest('[data-em-tpl-del]');
    if (del) {
      return confirmDialog({ title: 'Delete this template?', text: 'Campaigns already written from it are not affected.' }).then(async (ok) => {
        if (!ok) return;
        try { await api(`/api/email/templates/${del.dataset.emTplDel}`, { method: 'DELETE' }); loadTemplates(); } catch (err) { toast(err.message, 'error'); }
      });
    }
    return undefined;
  }
  root.addEventListener('click', rootClick);
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.em-row')) rootClick(e); });
  modalBody.addEventListener('click', (e) => {
    const s = e.target.closest('[data-em-subact]');
    if (s) subscriberAction(s.dataset.emSubact, s.dataset.id);
    const c = e.target.closest('[data-em-camp-act]');
    if (c) campaignAction(c.dataset.emCampAct, c.dataset.id);
    const pv = e.target.closest('[data-em-pv]');
    if (pv) {
      qa('[data-em-pv]', modalBody).forEach(b => b.classList.toggle('is-active', b === pv));
      q('#emPreviewFrame', modalBody).style.maxWidth = pv.dataset.emPv;
    }
  });

  window.EmailCenter = { load: () => setTab(state.tab) };
  if (/^#\/email/.test(location.hash) && !document.getElementById('view-email').hidden) window.EmailCenter.load();
})();
