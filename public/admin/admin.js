// public/admin/admin.js
// Admin dashboard. Every write is authorised and re-validated server-side
// (session + role + CSRF token); this file only handles the interface.
// No inline event handlers are used — the dashboard runs under a strict CSP.

(function () {
  'use strict';

  // =========================================================
  // Utilities
  // =========================================================
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#a-${n}"/></svg>`;
  const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const isHttpUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || '').trim());
  const safeUrl = (u) => { const s = String(u || '').trim(); return isHttpUrl(s) || (s.startsWith('/') && !s.startsWith('//')) ? s : ''; };
  const isPdfUrl = (u) => /\.pdf($|[?#])/i.test(String(u || ''));
  function timeAgo(d) {
    const date = new Date(d);
    const s = (Date.now() - date.getTime()) / 1000;
    if (isNaN(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)} d ago`;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const fmtSize = (b) => !b ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

  function toast(message, type = 'info', ms = 4200) {
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.textContent = message;
    $('#toastStack').appendChild(el);
    setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 220); }, ms);
  }
  function setLoading(btn, on, text = 'Saving…') {
    if (!btn) return;
    if (on) {
      btn.dataset.html = btn.dataset.html || btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(text)}`;
    } else {
      btn.disabled = false;
      if (btn.dataset.html) { btn.innerHTML = btn.dataset.html; delete btn.dataset.html; }
    }
  }

  // =========================================================
  // API (adds the CSRF token to every write)
  // =========================================================
  const state = { user: null, csrf: '', projects: [], migrated: true, services: [], messages: [], reviews: [], company: null };

  async function refreshSession() {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (data.authenticated) { state.user = data.user; state.csrf = data.csrfToken || ''; }
    return data;
  }

  async function api(path, opts = {}, retried = false) {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    const res = await fetch(path, { ...opts, method, headers, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin('Your session has ended. Please sign in again.'); throw new Error('Please sign in again.'); }
    if (res.status === 403 && data.code === 'CSRF' && !retried) { await refreshSession(); return api(path, opts, true); }
    if (!res.ok) { const err = new Error(data.error || 'Request failed. Please try again.'); err.code = data.code; err.status = res.status; throw err; }
    return data;
  }
  const json = (body) => JSON.stringify(body);

  // =========================================================
  // Dialogs
  // =========================================================
  const dialogStack = [];
  function openDialog(el, onClose) {
    if (!el.hidden) return;
    el.hidden = false;
    dialogStack.push({ el, opener: document.activeElement, onClose });
    document.body.classList.add('no-scroll');
    requestAnimationFrame(() => ($('[data-autofocus]', el) || $('.modal__body input:not([type=hidden]):not([type=file]), .modal__body textarea, .modal__body select, .modal__foot .btn--primary, .modal__foot .btn--danger, [data-dismiss].icon-btn', el))?.focus());
  }
  function closeDialog(el) {
    const i = dialogStack.findIndex(d => d.el === el);
    if (i === -1) return;
    const [d] = dialogStack.splice(i, 1);
    el.hidden = true;
    if (!dialogStack.length) document.body.classList.remove('no-scroll');
    d.onClose?.();
    if (d.opener && document.contains(d.opener)) d.opener.focus?.();
  }
  document.addEventListener('click', (e) => {
    const dismiss = e.target.closest('[data-dismiss]');
    if (dismiss) closeDialog(dismiss.closest('.modal'));
  });

  function confirmDialog({ title = 'Are you sure?', text = '', ok = 'Delete' } = {}) {
    return new Promise((resolve) => {
      const modal = $('#confirmModal');
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      const okBtn = $('#confirmOk');
      okBtn.textContent = ok;
      let answered = false;
      const finish = (v) => { if (answered) return; answered = true; okBtn.removeEventListener('click', onOk); resolve(v); };
      const onOk = () => { finish(true); closeDialog(modal); };
      okBtn.addEventListener('click', onOk);
      openDialog(modal, () => finish(false));
      requestAnimationFrame(() => okBtn.focus());
    });
  }

  document.addEventListener('keydown', (e) => {
    const top = dialogStack[dialogStack.length - 1];
    if (e.key === 'Escape') {
      if (top) { e.preventDefault(); closeDialog(top.el); return; }
      if (closePopovers()) return;
      if ($('#sidebar').classList.contains('is-open')) closeSidebar();
      return;
    }
    if (e.key === 'Tab' && top) {
      const f = $$('a[href], button:not([disabled]), input:not([type=hidden]):not([type=file]), select, textarea, iframe', top.el).filter(n => n.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
    if (e.key === '/' && !top && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('#dashScreen').hidden) {
      e.preventDefault();
      openSearch();
    }
  });

  // =========================================================
  // Form builder
  // =========================================================
  // Field: { name, label, type, required, hint, full, options, placeholder, maxlength, folder, accept }
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const DOC_TYPES = [...IMAGE_TYPES, 'application/pdf'];

  function fieldHtml(f, val, prefix = 'f') {
    const id = `${prefix}_${f.name}`;
    const req = f.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
    const hint = f.hint ? `<p class="field__hint" id="${id}_hint">${f.hint}</p>` : '';
    const describedBy = f.hint ? `aria-describedby="${id}_hint"` : '';
    const wrap = (inner) => `<div class="field ${f.full ? 'full' : ''}" data-field="${f.name}"><label for="${id}">${esc(f.label)}${req}</label>${inner}${hint}<p class="field__error" id="${id}_err" hidden></p></div>`;
    switch (f.type) {
      case 'switch':
        return `<label class="switch ${f.full ? 'full' : ''}"><input type="checkbox" id="${id}" ${val ? 'checked' : ''}><span class="switch__track"></span><span class="switch__text"><strong>${esc(f.label)}</strong>${f.hint ? `<small>${f.hint}</small>` : ''}</span></label>`;
      case 'textarea':
        return wrap(`<textarea id="${id}" rows="${f.rows || 4}" ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} ${f.required ? 'required' : ''} ${describedBy} placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`);
      case 'lines':
        return wrap(`<textarea id="${id}" rows="${f.rows || 4}" ${describedBy} placeholder="${esc(f.placeholder || '')}">${esc(Array.isArray(val) ? val.join('\n') : val)}</textarea>`);
      case 'select': {
        const opts = (f.options || []).slice();
        if (val && !opts.some(o => (o.value ?? o) === val)) opts.push({ value: val, label: `${val} (current)` });
        return wrap(`<select id="${id}" ${f.required ? 'required' : ''} ${describedBy}>${f.placeholderOption ? `<option value="">${esc(f.placeholderOption)}</option>` : ''}${opts.map(o => {
          const v = o.value ?? o; const l = o.label ?? o;
          return `<option value="${esc(v)}" ${String(v) === String(val ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
        }).join('')}</select>`);
      }
      case 'image':
      case 'document':
        return `<div class="field ${f.full ? 'full' : ''}" data-field="${f.name}"><span class="field__label">${esc(f.label)}${req}</span>${uploadHtml(f, val, id)}${hint}<p class="field__error" id="${id}_err" hidden></p></div>`;
      default: {
        const type = f.type === 'tags' ? 'text' : (f.type || 'text');
        const v = f.type === 'tags' && Array.isArray(val) ? val.join(', ') : val;
        return wrap(`<input type="${type}" id="${id}" value="${esc(v)}" ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} ${f.required ? 'required' : ''} ${describedBy} placeholder="${esc(f.placeholder || '')}" ${type === 'password' ? 'autocomplete="new-password"' : ''}>`);
      }
    }
  }

  function readField(f, prefix = 'f') {
    const el = document.getElementById(`${prefix}_${f.name}`);
    if (!el) return undefined;
    if (f.type === 'switch') return el.checked;
    if (f.type === 'tags') return el.value.split(',').map(s => s.trim()).filter(Boolean);
    if (f.type === 'lines') return el.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (f.type === 'number') return el.value === '' ? 0 : Number(el.value);
    return el.value.trim();
  }

  function validateFields(fields, prefix = 'f') {
    let firstBad = null;
    fields.forEach(f => {
      const el = document.getElementById(`${prefix}_${f.name}`);
      const err = document.getElementById(`${prefix}_${f.name}_err`);
      if (!el || !err) return;
      const v = f.type === 'switch' ? el.checked : String(el.value || '').trim();
      let msg = '';
      if (f.required && !v) msg = `${f.label} is required.`;
      else if (v && (f.type === 'url' || f.type === 'image' || f.type === 'document') && !safeUrl(v) && !/^PLACEHOLDER_/.test(v)) msg = 'Enter a full web address starting with https://';
      else if (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) msg = 'Enter a valid email address.';
      else if (f.validate) msg = f.validate(v) || '';
      err.textContent = msg;
      err.hidden = !msg;
      el.closest('.field')?.classList.toggle('has-error', !!msg);
      if (msg && !firstBad) firstBad = el.type === 'hidden' ? el.closest('.field')?.querySelector('button') : el;
    });
    firstBad?.focus();
    return !firstBad;
  }

  const formModal = $('#formModal');
  function openForm({ title, fields, initial = {}, submitLabel = 'Save changes', onSubmit, intro = '' }) {
    $('#formModalTitle').textContent = title;
    const form = $('#formModalForm');
    const switches = fields.filter(f => f.type === 'switch');
    const others = fields.filter(f => f.type !== 'switch');
    form.innerHTML = intro + others.map(f => fieldHtml(f, initial[f.name] ?? f.default ?? '')).join('') +
      (switches.length ? `<div class="switch-grid">${switches.map(f => fieldHtml(f, initial[f.name] ?? f.default ?? false)).join('')}</div>` : '');
    $$('.upload', form).forEach(wireUpload);
    const save = $('#formModalSave');
    save.textContent = submitLabel;
    form.onsubmit = async (e) => {
      e.preventDefault();
      if ($$('.upload.is-uploading', form).length) { toast('Please wait for the upload to finish.', 'info'); return; }
      if (!validateFields(fields)) return;
      const payload = {};
      fields.forEach(f => { const v = readField(f); if (v !== undefined) payload[f.name] = v; });
      setLoading(save, true);
      try {
        await onSubmit(payload);
        closeDialog(formModal);
        toast('Saved successfully.', 'success');
      } catch (err) {
        toast(err.message, 'error', 6000);
      } finally {
        setLoading(save, false);
      }
    };
    openDialog(formModal);
  }

  // =========================================================
  // Upload widget (images, and PDFs for document fields)
  // =========================================================
  function previewInner(url) {
    if (!url) return icon('media');
    if (isPdfUrl(url)) return icon('doc');
    return `<img src="${esc(url)}" alt="">`;
  }
  function uploadHtml(f, val, id) {
    const doc = f.type === 'document';
    const types = doc ? 'JPEG, PNG, WEBP or PDF — images up to 5MB, PDFs up to 10MB' : 'JPEG, PNG, WEBP or GIF — up to 5MB';
    return `<div class="upload" data-folder="${esc(f.folder || 'media')}" data-doc="${doc ? '1' : ''}" data-input="${id}">
      <div class="upload__preview ${doc ? 'upload__preview--doc' : ''}">${previewInner(val)}</div>
      <div class="upload__body">
        <div class="upload__actions">
          <input type="file" accept="${(doc ? DOC_TYPES : IMAGE_TYPES).join(',')}" hidden>
          <button type="button" class="btn btn--ghost btn--sm" data-choose>${icon('upload')}${val ? 'Replace file' : 'Upload file'}</button>
          ${val ? `<a class="btn btn--ghost btn--sm" href="${esc(safeUrl(val))}" target="_blank" rel="noopener" data-view-current>${icon('external')}View</a>` : ''}
          <button type="button" class="btn btn--ghost btn--sm" data-remove ${val ? '' : 'hidden'}>Remove</button>
        </div>
        <div class="upload__bar" hidden><span></span></div>
        <p class="upload__status">${types}. Or drag a file here.</p>
        <details class="upload__url"><summary>Use a web address instead</summary><input type="url" id="${id}" value="${esc(val)}" placeholder="https://…" aria-label="${esc(f.label)} web address"></details>
      </div>
    </div>`;
  }

  function wireUpload(box) {
    const input = $(`#${box.dataset.input}`);
    const file = $('input[type=file]', box);
    const preview = $('.upload__preview', box);
    const status = $('.upload__status', box);
    const bar = $('.upload__bar', box);
    const removeBtn = $('[data-remove]', box);
    const chooseBtn = $('[data-choose]', box);
    const doc = !!box.dataset.doc;
    const allowed = doc ? DOC_TYPES : IMAGE_TYPES;
    const setStatus = (msg, cls = '') => { status.textContent = msg; status.className = `upload__status ${cls}`; };

    chooseBtn.addEventListener('click', () => file.click());
    removeBtn.addEventListener('click', () => { input.value = ''; preview.innerHTML = previewInner(''); removeBtn.hidden = true; $('[data-view-current]', box)?.remove(); setStatus('File removed. Save to apply.'); });
    input.addEventListener('change', () => { preview.innerHTML = previewInner(input.value.trim()); removeBtn.hidden = !input.value.trim(); });
    file.addEventListener('change', () => { if (file.files[0]) send(file.files[0]); file.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add('is-dragover'); }));
    ['dragleave', 'drop'].forEach(ev => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.remove('is-dragover'); }));
    box.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) send(f); });

    function send(f) {
      if (!allowed.includes(f.type)) { setStatus(doc ? 'Unsupported file. Use a JPEG, PNG, WEBP image or a PDF.' : 'Unsupported file. Use a JPEG, PNG, WEBP or GIF image.', 'is-error'); return; }
      const max = f.type === 'application/pdf' ? 10 : 5;
      if (f.size > max * 1048576) { setStatus(`That file is too large (maximum ${max}MB).`, 'is-error'); return; }
      const previous = input.value;
      const local = f.type.startsWith('image/') ? URL.createObjectURL(f) : '';
      preview.innerHTML = `${local ? `<img src="${local}" alt="">` : icon('doc')}<span class="upload__overlay"><span class="spinner"></span></span>`;
      bar.hidden = false;
      box.classList.add('is-uploading');
      uploadFile(f, { folder: box.dataset.folder }, (pct) => { $('span', bar).style.width = `${pct}%`; setStatus(`Uploading… ${pct}%`); })
        .then((data) => {
          input.value = data.url;
          preview.innerHTML = previewInner(data.url);
          removeBtn.hidden = false;
          setStatus(`Uploaded “${f.name}”. Save to apply.`, 'is-success');
        })
        .catch((err) => {
          input.value = previous;
          preview.innerHTML = previewInner(previous);
          setStatus(err.message, 'is-error');
        })
        .finally(() => { bar.hidden = true; $('span', bar).style.width = '0'; box.classList.remove('is-uploading'); if (local) URL.revokeObjectURL(local); });
    }
  }

  // XHR (not fetch) so we can report upload progress
  function uploadFile(f, fields = {}, onProgress, endpoint = '/api/upload') {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      fd.append('file', f);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.setRequestHeader('X-CSRF-Token', state.csrf);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded / e.total * 100)); });
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else if (xhr.status === 403 && data.code === 'CSRF') refreshSession().then(() => uploadFile(f, fields, onProgress, endpoint)).then(resolve, reject);
        else reject(new Error(data.error || 'Upload failed. Please try again.'));
      };
      xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
      xhr.send(fd);
    });
  }

  // =========================================================
  // Auth
  // =========================================================
  function showLogin(message) {
    $('#dashScreen').hidden = true;
    $('#loginScreen').hidden = false;
    const err = $('#loginError');
    if (message) { err.textContent = message; err.hidden = false; } else err.hidden = true;
    setTimeout(() => $('#loginUsername').focus(), 50);
  }

  async function boot() {
    try {
      const s = await refreshSession();
      if (s.authenticated) startApp(); else showLogin();
    } catch {
      showLogin('Could not reach the server. Check your connection and refresh.');
    }
  }

  $('#togglePassword').addEventListener('click', (e) => {
    const input = $('#loginPassword');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    e.currentTarget.innerHTML = icon(show ? 'eye-off' : 'preview');
  });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.currentTarget);
    const err = $('#loginError');
    const username = $('#loginUsername').value.trim();
    const password = $('#loginPassword').value;
    if (!username || !password) { err.textContent = 'Enter your username and password.'; err.hidden = false; return; }
    err.hidden = true;
    setLoading(btn, true, 'Signing in…');
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: json({ username, password }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign-in failed.');
      state.user = data.user;
      state.csrf = data.csrfToken;
      $('#loginPassword').value = '';
      startApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      setLoading(btn, false);
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* signing out anyway */ }
    state.user = null;
    location.hash = '';
    location.reload();
  });

  // =========================================================
  // Shell: sidebar, popovers, router
  // =========================================================
  const isAdmin = () => (state.user?.role || 'admin') === 'admin';
  const sidebar = $('#sidebar');
  function openSidebar() { sidebar.classList.add('is-open'); $('#sidebarOverlay').classList.add('is-visible'); $('#sidebarOpen').setAttribute('aria-expanded', 'true'); setTimeout(() => $('.sidebar__nav a.is-active', sidebar)?.focus({ preventScroll: true }), 60); }
  function closeSidebar() { sidebar.classList.remove('is-open'); $('#sidebarOverlay').classList.remove('is-visible'); $('#sidebarOpen').setAttribute('aria-expanded', 'false'); }
  $('#sidebarOpen').addEventListener('click', openSidebar);
  $('#sidebarClose').addEventListener('click', closeSidebar);
  $('#sidebarOverlay').addEventListener('click', closeSidebar);
  $('#sidebarCollapse').addEventListener('click', (e) => {
    const on = !$('#dashScreen').classList.contains('is-collapsed');
    $('#dashScreen').classList.toggle('is-collapsed', on);
    e.currentTarget.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('admin_sidebar_collapsed', on ? '1' : ''); } catch { /* ignore */ }
  });

  function togglePopover(btn, panel) {
    const open = panel.hidden;
    closePopovers();
    if (open) { panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  }
  function closePopovers() {
    let closed = false;
    [['#notifBtn', '#notifPanel'], ['#profileBtn', '#profileMenu']].forEach(([b, p]) => {
      if (!$(p).hidden) { $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false'); closed = true; }
    });
    if (!$('#globalSearchResults').hidden) { $('#globalSearchResults').hidden = true; closed = true; }
    return closed;
  }
  $('#notifBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePopover(e.currentTarget, $('#notifPanel')); });
  $('#profileBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePopover(e.currentTarget, $('#profileMenu')); });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-pop]')) { closePopovers(); return; }
    if (!e.target.closest('.menu-wrap') && !e.target.closest('#globalSearch')) {
      closePopovers();
      $('#globalSearch').classList.remove('is-mobile-open');
    }
  });

  const VIEWS = {
    overview: { title: 'Overview', load: () => loadOverview() },
    projects: { title: 'Manage Projects', load: () => loadProjects() },
    previews: { title: 'Project Previews', load: () => loadPreviews() },
    services: { title: 'Services', load: () => loadServices() },
    company: { title: 'About the Company', load: () => loadCompany() },
    media: { title: 'Images & Documents', load: () => loadMedia() },
    blog: { title: 'SHEREBOY BLOG Connection', load: () => loadBlogConnection() },
    affiliate: { title: 'Affiliate Integration', load: () => loadAffiliateIntegration() },
    reviews: { title: 'Client Reviews', load: () => loadReviews() },
    messages: { title: 'Contact Messages', load: () => loadMessages() },
    accounts: { title: 'Administrator Accounts', load: () => loadAccounts(), admin: true },
    security: { title: 'Security & Activity', load: () => loadActivity(), admin: true }
  };

  function route() {
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    let view = VIEWS[path] ? path : (path === 'insights' ? 'blog' : 'overview');
    if (VIEWS[view].admin && !isAdmin()) { toast('Only administrators can open that section.', 'error'); view = 'overview'; }
    $$('.view').forEach(v => { v.hidden = v.id !== `view-${view}`; });
    $$('#sidebarNav a').forEach(a => {
      const on = a.dataset.view === view;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('#crumbCurrent').textContent = VIEWS[view].title;
    document.title = `${VIEWS[view].title} — SHEREBOY TECH LTD Admin`;
    closeSidebar();
    closePopovers();
    window.scrollTo(0, 0);
    VIEWS[view].load();
    const params = new URLSearchParams(query);
    if (view === 'projects' && params.get('new')) { history.replaceState(null, '', '#/projects'); setTimeout(() => newProject(), 50); }
    if (view === 'projects' && params.get('edit')) { history.replaceState(null, '', '#/projects'); setTimeout(() => editProjectById(params.get('edit')), 300); }
    if (view === 'messages' && params.get('open')) { history.replaceState(null, '', '#/messages'); setTimeout(() => openMessage(params.get('open')), 300); }
  }

  function startApp() {
    $('#loginScreen').hidden = true;
    $('#dashScreen').hidden = false;
    const u = state.user || {};
    $('#adminUsername').textContent = u.username || 'Admin';
    $('#adminAvatar').textContent = (u.username || 'A').slice(0, 1);
    $('#adminRole').textContent = isAdmin() ? 'Administrator' : 'Editor';
    $$('[data-admin-only]').forEach(el => { el.hidden = !isAdmin(); });
    $('#greeting').textContent = `Welcome back, ${u.username || 'admin'}`;
    try { if (localStorage.getItem('admin_sidebar_collapsed')) $('#dashScreen').classList.add('is-collapsed'); } catch { /* ignore */ }
    window.addEventListener('hashchange', route);
    route();
    refreshNotifications();
    setInterval(refreshNotifications, 120000);
  }

  $$('[data-refresh]').forEach(b => b.addEventListener('click', () => VIEWS[b.dataset.refresh]?.load()));

  // =========================================================
  // Notifications (real unread messages)
  // =========================================================
  async function refreshNotifications() {
    try {
      const { messages } = await api('/api/contact/admin/all');
      state.messages = messages || [];
      updateUnread();
    } catch { /* non-critical */ }
  }
  function updateUnread() {
    const unread = state.messages.filter(m => !m.read);
    const badge = $('#unreadBadge');
    badge.hidden = !unread.length;
    badge.textContent = unread.length;
    $('#notifDot').hidden = !unread.length;
    $('#notifBtn').setAttribute('aria-label', unread.length ? `Notifications: ${unread.length} unread messages` : 'Notifications');
    $('#notifList').innerHTML = unread.length
      ? unread.slice(0, 6).map(m => `<a class="notif__item" href="#/messages?open=${esc(m.id)}" data-close-pop><strong>${esc(m.name)}</strong><span>${esc(m.subject || m.message)}</span><span>${timeAgo(m.created_at)}</span></a>`).join('')
      : `<p class="notif__empty">You're all caught up — no unread messages.</p>`;
  }

  // =========================================================
  // Global search (across data already loaded / fetched on demand)
  // =========================================================
  const searchInput = $('#globalSearchInput');
  const searchResults = $('#globalSearchResults');
  function openSearch() {
    $('#globalSearch').classList.add('is-mobile-open');
    searchInput.focus();
  }
  $('#searchToggle').addEventListener('click', (e) => { e.stopPropagation(); openSearch(); });
  let searchPrimed = false;
  async function primeSearch() {
    if (searchPrimed) return;
    searchPrimed = true;
    const [p, s] = await Promise.allSettled([api('/api/projects/admin/all'), api('/api/services/admin/all')]);
    if (p.status === 'fulfilled') state.projects = p.value.projects || [];
    if (s.status === 'fulfilled') state.services = s.value.services || [];
  }
  searchInput.addEventListener('focus', primeSearch);
  searchInput.addEventListener('input', debounce(() => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchResults.hidden = true; searchInput.setAttribute('aria-expanded', 'false'); return; }
    const hit = (...vals) => vals.some(v => String(v || '').toLowerCase().includes(q));
    const groups = [
      ['Projects', state.projects.filter(p => hit(p.title, p.client_name, p.category, (p.technologies || []).join(' '))).slice(0, 5).map(p => [`#/projects?edit=${p.id}`, p.title, p.category || ''])],
      ['Messages', state.messages.filter(m => hit(m.name, m.email, m.subject, m.message)).slice(0, 5).map(m => [`#/messages?open=${m.id}`, m.name, m.subject || m.email])],
      ['Services', state.services.filter(s => hit(s.title, s.description)).slice(0, 4).map(s => ['#/services', s.title, 'Service'])]
    ].filter(([, items]) => items.length);
    searchResults.innerHTML = groups.length
      ? groups.map(([g, items]) => `<p class="search-results__group">${g}</p>${items.map(([href, t, sub]) => `<a href="${esc(href)}" role="option" data-close-pop>${esc(t)}<small>${esc(sub)}</small></a>`).join('')}`).join('')
      : `<p class="notif__empty">No results for “${esc(q)}”.</p>`;
    searchResults.hidden = false;
    searchInput.setAttribute('aria-expanded', 'true');
  }, 150));
  searchInput.addEventListener('keydown', (e) => {
    const links = $$('a', searchResults);
    if (!links.length) return;
    const i = links.findIndex(a => a.classList.contains('is-active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (i + 1) % links.length : (i - 1 + links.length) % links.length;
      links.forEach(a => a.classList.remove('is-active'));
      links[next].classList.add('is-active');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (links[i] || links[0]).click();
      searchInput.value = '';
      searchResults.hidden = true;
      $('#globalSearch').classList.remove('is-mobile-open');
    }
  });

  // =========================================================
  // Shared row helpers
  // =========================================================
  const skeletonRows = (cols, n = 4) => Array.from({ length: n }).map(() => `<tr>${Array.from({ length: cols }).map((_, i) => `<td><span class="skeleton" style="width:${i === 0 ? 70 : 50}%"></span></td>`).join('')}</tr>`).join('');
  const errorRow = (cols, msg, retry) => `<tr><td colspan="${cols}"><div class="error-row">${icon('warning')}${esc(msg)}<button type="button" class="retry-btn" data-retry="${retry}">Try again</button></div></td></tr>`;
  document.addEventListener('click', (e) => { const r = e.target.closest('[data-retry]'); if (r) VIEWS[r.dataset.retry]?.load(); });
  const thumb = (url, round) => {
    const u = safeUrl(url);
    return `<span class="thumb ${round ? 'thumb--round' : ''}">${u && !isPdfUrl(u) ? `<img src="${esc(u)}" alt="" loading="lazy" data-thumb>` : icon(round ? 'user' : 'media')}</span>`;
  };
  // Broken thumbnails fall back to an icon (no inline onerror handlers under CSP)
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.hasAttribute('data-thumb')) { img.parentElement.innerHTML = icon('warning'); img.parentElement?.setAttribute('title', 'Image could not be loaded'); }
  }, true);
  const visibilityPill = (pub) => pub ? '<span class="pill pill--green">Published</span>' : '<span class="pill pill--grey">Draft</span>';
  const btnIcon = (name, label, attrs, variant = '') => `<button type="button" class="icon-btn icon-btn--sm ${variant}" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name)}</button>`;

  async function deleteItem({ label, url, after }) {
    const ok = await confirmDialog({ title: `Delete ${label}?`, text: 'This permanently removes it and cannot be undone.' });
    if (!ok) return;
    try {
      await api(url, { method: 'DELETE' });
      toast('Deleted.', 'success');
      after?.();
    } catch (err) { toast(err.message, 'error'); }
  }

  // =========================================================
  // Overview
  // =========================================================
  const STATUS_LABELS = { completed: 'Completed', in_progress: 'In progress', maintenance: 'Ongoing support' };
  const STATUS_PILL = { completed: 'pill--green', in_progress: 'pill--amber', maintenance: 'pill--blue' };

  async function loadOverview() {
    const kpis = $('#kpis');
    kpis.innerHTML = Array.from({ length: 6 }).map(() => '<div class="kpi"><span class="skeleton" style="height:34px;width:34px"></span><span class="skeleton" style="height:24px;width:40%"></span><span class="skeleton" style="width:70%"></span></div>').join('');
    try {
      const s = await api('/api/dashboard/stats');
      const kpi = (href, ic, value, label, mod = '') => `<a class="kpi ${mod}" href="${href}"><span class="kpi__icon">${icon(ic)}</span><span class="kpi__value">${value}</span><span class="kpi__label">${label}</span></a>`;
      kpis.innerHTML = [
        kpi('#/projects', 'projects', s.totalProjects, 'Total projects'),
        kpi('#/projects', 'preview', s.publishedProjects, 'Published projects', 'kpi--good'),
        kpi('#/projects', 'edit', s.draftProjects, 'Draft projects', 'kpi--muted'),
        kpi('#/messages', 'inbox', s.totalMessages, 'Contact enquiries'),
        kpi('#/messages', 'messages', s.unreadMessages, 'Unread messages', s.unreadMessages ? 'kpi--alert' : 'kpi--muted'),
        kpi('#/services', 'services', `${s.publishedServices}<small style="font-size:.9rem;color:var(--dim)"> / ${s.totalServices}</small>`, 'Services published')
      ].join('');

      // Enquiries per month — single series bar chart
      const months = s.enquiriesByMonth || [];
      const max = Math.max(1, ...months.map(m => m.count));
      const total = months.reduce((a, m) => a + m.count, 0);
      $('#chartEnquiries').innerHTML = total === 0
        ? '<p class="empty-chart">No enquiries in the last 6 months yet.</p>'
        : `<p class="chart__summary"><strong>${total}</strong> enquir${total === 1 ? 'y' : 'ies'} in the last 6 months</p>
           <div class="bars" role="img" aria-label="Enquiries per month: ${months.map(m => `${m.label} ${m.count}`).join(', ')}">
             ${months.map(m => { const h = Math.round(m.count / max * 100); return `<div class="bar" tabindex="0" style="--h:${h}%"><span class="bar__tip">${m.label}: ${m.count} enquir${m.count === 1 ? 'y' : 'ies'}</span><span class="bar__fill" style="height:${h}%"></span></div>`; }).join('')}
           </div>
           <div class="bar-labels" aria-hidden="true">${months.map(m => `<span>${m.label}</span>`).join('')}</div>`;

      // Projects by status — labelled horizontal bars
      const statuses = Object.entries(s.projectsByStatus || {});
      const smax = Math.max(1, ...statuses.map(([, n]) => n));
      $('#chartStatus').innerHTML = statuses.length
        ? `<div class="hbar">${statuses.map(([k, n]) => `<div class="hbar__row"><span class="hbar__label"><span class="pill ${STATUS_PILL[k] || 'pill--grey'}">${esc(STATUS_LABELS[k] || k)}</span></span><span class="hbar__track"><span class="hbar__fill" style="width:${n / smax * 100}%"></span></span><span class="hbar__value">${n}</span></div>`).join('')}</div>
           <p class="chart__summary">${s.featuredProjects} featured · ${s.projectsWithLiveSite} with a live website${s.projectsMissingImage ? ` · <strong>${s.projectsMissingImage}</strong> missing a thumbnail` : ''}</p>`
        : '<p class="empty-chart">No projects yet. <a href="#/projects?new=1">Add your first project</a>.</p>';

      // Content status
      const cs = s.contentStatus || [];
      const done = cs.filter(c => c.complete).length;
      $('#contentStatus').innerHTML = `<p class="chart__summary"><strong>${done} of ${cs.length}</strong> items complete</p>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${cs.length}" aria-valuenow="${done}" aria-label="Content completeness"><span style="width:${cs.length ? done / cs.length * 100 : 0}%"></span></div>
        <ul class="checklist">${cs.map(c => `<li class="${c.complete ? 'is-done' : ''}">${icon(c.complete ? 'check' : 'warning')}${esc(c.label)}${c.complete ? '' : '<span class="sr-only"> — missing</span>'}</li>`).join('')}</ul>`;

      renderActivityList(s.recentActivity || []);
      if (Number.isFinite(s.unreadMessages)) { $('#unreadBadge').hidden = !s.unreadMessages; $('#unreadBadge').textContent = s.unreadMessages; $('#notifDot').hidden = !s.unreadMessages; }
    } catch (err) {
      kpis.innerHTML = `<div class="error-row" style="grid-column:1/-1">${icon('warning')}Could not load dashboard figures. <button type="button" class="retry-btn" data-retry="overview">Try again</button></div>`;
    }
  }
  const ACTION_LABELS = {
    login: 'Signed in', logout: 'Signed out', login_failed: 'Failed sign-in', project_created: 'Project added', project_edited: 'Project edited',
    project_deleted: 'Project deleted', projects_reordered: 'Projects reordered', service_created: 'Service added', service_edited: 'Service edited',
    service_deleted: 'Service deleted', blog_created: 'Article added', blog_edited: 'Article edited', blog_deleted: 'Article deleted',
    review_created: 'Review added', review_edited: 'Review edited', review_deleted: 'Review deleted', company_updated: 'Company details updated',
    contact_deleted: 'Message deleted', blog_feed_refreshed: 'SHEREBOY BLOG refreshed', affiliate_feed_refreshed: 'Affiliate products refreshed', contact_read: 'Message read', contact_unread: 'Message marked unread', file_uploaded: 'File uploaded',
    media_edited: 'File description edited', media_replaced: 'File replaced', media_deleted: 'File deleted', admin_created: 'Account created',
    admin_updated: 'Account updated', admin_deleted: 'Account deleted'
  };
  const actionLabel = (a) => ACTION_LABELS[a] || String(a || '').replace(/_/g, ' ');
  function renderActivityList(items) {
    $('#activityList').innerHTML = items.length
      ? items.map(a => `<li><span class="activity__dot ${a.action === 'login_failed' ? 'activity__dot--warn' : ''}"></span><span><strong>${esc(actionLabel(a.action))}</strong><br><span style="color:var(--muted)">${esc(a.details || '')}</span></span><span class="activity__time">${timeAgo(a.created_at)}</span></li>`).join('')
      : '<li><span></span><span style="color:var(--dim)">No activity recorded yet.</span><span></span></li>';
  }

  // =========================================================
  // Projects
  // =========================================================
  const CATEGORIES = ['Websites', 'Web Applications', 'Mobile Applications', 'Business Software', 'Other Projects'];
  const projectFields = () => [
    { name: 'title', label: 'Project name', required: true, maxlength: 200 },
    { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, required: true, placeholderOption: 'Choose a category', hint: 'Categories with at least one published project appear as filters on the website.' },
    { name: 'status', label: 'Project status', type: 'select', options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })) },
    { name: 'description', label: 'Description', type: 'textarea', rows: 6, maxlength: 5000, required: true, hint: 'The first paragraph is shown on the project card; the full text appears in the project details.' },
    { name: 'image_url', label: 'Thumbnail / screenshot', type: 'image', folder: 'projects', hint: 'Use a real screenshot of the project. Landscape (16:10) works best.' },
    { name: 'technologies', label: 'Technologies used', type: 'tags', placeholder: 'e.g. HTML, CSS, Node.js', hint: 'Separate with commas.' },
    { name: 'client_name', label: 'Client name', maxlength: 150 },
    { name: 'completion_date', label: 'Completion date', type: 'date' },
    { name: 'live_url', label: 'Live website address', type: 'url', placeholder: 'https://', hint: 'Needed for the “Live Preview” and “Visit Website” buttons.' },
    { name: 'github_url', label: 'Source code address (optional)', type: 'url', placeholder: 'https://github.com/…' },
    { name: 'published', label: 'Visible on website', type: 'switch', default: true, hint: 'Turn off to keep as a draft.' },
    { name: 'featured', label: 'Featured project', type: 'switch', hint: 'Highlighted at the top of the portfolio.' },
    { name: 'preview_enabled', label: 'Allow live preview', type: 'switch', default: true, hint: 'Shows the “Live Preview” button.' }
  ];

  const pState = { page: 1, perPage: 10, reorder: false, order: [] };
  async function loadProjects() {
    const tbody = $('#projectsTable tbody');
    tbody.innerHTML = skeletonRows(6);
    $('#projectsPager').innerHTML = '';
    try {
      const data = await api('/api/projects/admin/all');
      state.projects = data.projects || [];
      state.migrated = data.migrated !== false;
      const notice = $('#migrationNotice');
      notice.hidden = state.migrated;
      notice.innerHTML = `${icon('warning')}<div><strong>Database update needed for ordering and preview controls.</strong> Run <code>database/migrations/2026-10-29-portfolio-media-admin.sql</code> in the Supabase SQL editor. Everything else works normally until then.</div>`;
      $('#reorderToggle').disabled = !state.migrated;
      const cats = [...new Set(state.projects.map(p => p.category).filter(Boolean))].sort();
      const sel = $('#pCategory');
      const cur = sel.value;
      sel.innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('');
      renderProjects();
    } catch (err) {
      tbody.innerHTML = errorRow(6, err.message || 'Could not load projects.', 'projects');
    }
  }
  ['#pSearch', '#pCategory', '#pStatus', '#pVisibility', '#pSort'].forEach(s => $(s).addEventListener(s === '#pSearch' ? 'input' : 'change', debounce(() => { pState.page = 1; renderProjects(); }, 120)));

  function filteredProjects() {
    const q = $('#pSearch').value.trim().toLowerCase();
    const cat = $('#pCategory').value;
    const st = $('#pStatus').value;
    const vis = $('#pVisibility').value;
    let list = state.projects.filter(p =>
      (!q || [p.title, p.client_name, p.category, ...(p.technologies || [])].join(' ').toLowerCase().includes(q)) &&
      (!cat || p.category === cat) && (!st || (p.status || 'completed') === st) &&
      (!vis || (vis === 'published' ? p.published : !p.published)));
    const sort = $('#pSort').value;
    if (sort === 'name') list = list.slice().sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'updated') list = list.slice().sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    else list = list.slice().sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0) || new Date(b.created_at) - new Date(a.created_at));
    return list;
  }

  function renderProjects() {
    const tbody = $('#projectsTable tbody');
    if (pState.reorder) return renderReorder();
    const list = filteredProjects();
    const pages = Math.max(1, Math.ceil(list.length / pState.perPage));
    pState.page = Math.min(pState.page, pages);
    const slice = list.slice((pState.page - 1) * pState.perPage, pState.page * pState.perPage);
    tbody.innerHTML = slice.length ? slice.map(p => `<tr>
        <td class="cell-main"><div class="row-title">${thumb(p.image_url)}<div><strong>${esc(p.title)}</strong><small>${esc(p.client_name || '')}${p.featured ? ` · ${icon('star', '')} Featured` : ''}</small></div></div></td>
        <td data-label="Category">${esc(p.category || '—')}</td>
        <td data-label="Status"><span class="pill ${STATUS_PILL[p.status] || 'pill--green'}">${STATUS_LABELS[p.status] || 'Completed'}</span></td>
        <td data-label="Visibility">${visibilityPill(p.published)}</td>
        <td data-label="Updated">${timeAgo(p.updated_at || p.created_at)}</td>
        <td class="col-actions"><div class="row-actions">
          ${btnIcon('edit', `Edit ${p.title}`, `data-edit="${esc(p.id)}"`)}
          ${btnIcon(p.published ? 'eye-off' : 'preview', p.published ? 'Unpublish (make draft)' : 'Publish', `data-publish="${esc(p.id)}"`)}
          ${p.published ? `<a class="icon-btn icon-btn--sm" href="/projects/${esc(p.id)}" target="_blank" rel="noopener" aria-label="View ${esc(p.title)} on website" title="View on website">${icon('external')}</a>` : ''}
          ${btnIcon('trash', `Delete ${p.title}`, `data-delete="${esc(p.id)}"`, 'icon-btn--danger')}
        </div></td></tr>`).join('')
      : `<tr><td colspan="6" class="table-empty">${state.projects.length ? 'No projects match your filters.' : 'No projects yet — add your first project.'}</td></tr>`;
    $('#projectsPager').innerHTML = list.length > pState.perPage
      ? `<span>Showing ${(pState.page - 1) * pState.perPage + 1}–${Math.min(pState.page * pState.perPage, list.length)} of ${list.length}</span><div><button class="btn btn--ghost btn--sm" data-page="-1" ${pState.page === 1 ? 'disabled' : ''}>Previous</button><button class="btn btn--ghost btn--sm" data-page="1" ${pState.page === pages ? 'disabled' : ''}>Next</button></div>`
      : (list.length ? `<span>${list.length} project${list.length === 1 ? '' : 's'}</span>` : '');
  }
  $('#projectsPager').addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b) { pState.page += Number(b.dataset.page); renderProjects(); } });

  $('#projectsTable').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.edit) editProjectById(t.dataset.edit);
    if (t.dataset.delete) { const p = state.projects.find(x => x.id === t.dataset.delete); deleteItem({ label: `“${p.title}”`, url: `/api/projects/${p.id}`, after: loadProjects }); }
    if (t.dataset.publish) {
      const p = state.projects.find(x => x.id === t.dataset.publish);
      setLoading(t, true, '');
      try { await api(`/api/projects/${p.id}`, { method: 'PUT', body: json({ published: !p.published }) }); toast(p.published ? 'Project moved to drafts.' : 'Project published.', 'success'); loadProjects(); }
      catch (err) { toast(err.message, 'error'); setLoading(t, false); }
    }
    if (t.dataset.move) {
      const i = pState.order.indexOf(t.dataset.id);
      const j = i + Number(t.dataset.move);
      if (j < 0 || j >= pState.order.length) return;
      [pState.order[i], pState.order[j]] = [pState.order[j], pState.order[i]];
      renderReorder();
      $(`[data-id="${t.dataset.id}"][data-move="${t.dataset.move}"]`)?.focus();
    }
  });

  function projectPayload(v) {
    const p = { ...v };
    if (!state.migrated) delete p.preview_enabled;
    return p;
  }
  function editProjectById(id) {
    const p = state.projects.find(x => x.id === id);
    if (!p) { toast('That project could not be found.', 'error'); return; }
    openForm({
      title: `Edit project`,
      fields: projectFields(),
      initial: { ...p, preview_enabled: p.preview_enabled !== false },
      onSubmit: async (v) => { await api(`/api/projects/${p.id}`, { method: 'PUT', body: json(projectPayload(v)) }); loadProjects(); }
    });
  }
  function newProject() {
    openForm({
      title: 'Add project',
      fields: projectFields(),
      initial: { status: 'completed', published: true, preview_enabled: true },
      submitLabel: 'Add project',
      onSubmit: async (v) => { await api('/api/projects', { method: 'POST', body: json(projectPayload(v)) }); loadProjects(); }
    });
  }
  $('#newProjectBtn').addEventListener('click', newProject);

  // Reorder mode
  function renderReorder() {
    const tbody = $('#projectsTable tbody');
    const byId = Object.fromEntries(state.projects.map(p => [p.id, p]));
    tbody.innerHTML = pState.order.map((id, i) => { const p = byId[id]; return `<tr>
      <td class="cell-main"><div class="row-title"><span class="pill pill--grey">${i + 1}</span>${thumb(p.image_url)}<div><strong>${esc(p.title)}</strong></div></div></td>
      <td data-label="Category">${esc(p.category || '—')}</td><td data-label="Status"><span class="pill ${STATUS_PILL[p.status] || 'pill--green'}">${STATUS_LABELS[p.status] || 'Completed'}</span></td>
      <td data-label="Visibility">${visibilityPill(p.published)}</td><td></td>
      <td class="col-actions"><div class="row-actions">
        <button type="button" class="icon-btn icon-btn--sm" data-move="-1" data-id="${esc(id)}" aria-label="Move ${esc(p.title)} up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
        <button type="button" class="icon-btn icon-btn--sm" data-move="1" data-id="${esc(id)}" aria-label="Move ${esc(p.title)} down" ${i === pState.order.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
      </div></td></tr>`; }).join('');
    $('#projectsPager').innerHTML = '';
  }
  function setReorder(on) {
    pState.reorder = on;
    $('#reorderBar').hidden = !on;
    $('#projectToolbar').hidden = on;
    $('#reorderToggle').setAttribute('aria-pressed', String(on));
    if (on) {
      pState.order = state.projects.slice().sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0) || new Date(b.created_at) - new Date(a.created_at)).map(p => p.id);
    }
    renderProjects();
  }
  $('#reorderToggle').addEventListener('click', () => setReorder(!pState.reorder));
  $('#reorderCancel').addEventListener('click', () => setReorder(false));
  $('#reorderSave').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      await api('/api/projects/admin/reorder', { method: 'PUT', body: json({ ids: pState.order }) });
      toast('New order saved. The website now shows projects in this order.', 'success');
      pState.reorder = false;
      $('#reorderBar').hidden = true;
      $('#projectToolbar').hidden = false;
      $('#reorderToggle').setAttribute('aria-pressed', 'false');
      $('#pSort').value = 'order';
      loadProjects();
    } catch (err) { toast(err.message, 'error', 7000); }
    finally { setLoading(btn, false); }
  });

  // =========================================================
  // Project previews
  // =========================================================
  async function loadPreviews() {
    const list = $('#previewList');
    list.innerHTML = '<div class="card"><span class="skeleton" style="width:60%"></span><span class="skeleton" style="width:40%"></span></div>';
    try {
      const data = await api('/api/projects/admin/all');
      state.projects = data.projects || [];
      state.migrated = data.migrated !== false;
      if (!state.projects.length) { list.innerHTML = `<div class="empty">${icon('projects')}<p>No projects yet.</p></div>`; return; }
      list.innerHTML = state.projects.map(p => {
        const live = safeUrl(p.live_url);
        return `<article class="preview-item" data-pid="${esc(p.id)}">
          <div class="row-title">${thumb(p.image_url)}<div><strong>${esc(p.title)}</strong><span class="preview-item__url">${live ? esc(live) : 'No live website address'}</span></div></div>
          <div class="preview-item__result" data-result>${live ? '<span class="pill pill--grey">Not checked yet</span>' : '<span class="pill pill--grey">Preview unavailable — add a live address</span>'}</div>
          <div class="preview-item__actions">
            ${state.migrated ? `<label class="switch"><input type="checkbox" data-toggle-preview ${p.preview_enabled !== false ? 'checked' : ''} ${live ? '' : 'disabled'}><span class="switch__track"></span><span class="switch__text"><strong>Live Preview</strong></span></label>` : ''}
            ${live ? `<button type="button" class="btn btn--ghost btn--sm" data-check>${icon('refresh')}Check</button>` : `<a class="btn btn--ghost btn--sm" href="#/projects?edit=${esc(p.id)}">${icon('edit')}Add address</a>`}
            ${live && p.published ? `<a class="btn btn--ghost btn--sm" href="/projects/${esc(p.id)}" target="_blank" rel="noopener">${icon('external')}Open</a>` : ''}
          </div>
        </article>`;
      }).join('') + (state.migrated ? '' : `<div class="notice notice--warn">${icon('warning')}<div>The per-project Live Preview switch needs the database update in <code>database/migrations/2026-10-29-portfolio-media-admin.sql</code>. Until then, every project with a live address shows the preview button.</div></div>`);
      $$('[data-check]', list).forEach(b => checkPreview(b.closest('[data-pid]')));
    } catch (err) {
      list.innerHTML = `<div class="error-row">${icon('warning')}${esc(err.message)}<button type="button" class="retry-btn" data-retry="previews">Try again</button></div>`;
    }
  }
  async function checkPreview(item, fresh = false) {
    const out = $('[data-result]', item);
    out.innerHTML = '<span class="pill pill--grey"><span class="spinner" style="width:10px;height:10px"></span> Checking…</span>';
    try {
      const r = await api(`/api/projects/admin/${item.dataset.pid}/preview-check${fresh ? '?fresh=1' : ''}`);
      out.innerHTML = r.embeddable === true ? '<span class="pill pill--green">Can be previewed inside your website</span>'
        : r.embeddable === false ? `<span class="pill pill--amber">Opens in a new tab</span><br><small style="color:var(--dim)">${esc(r.reason || '')}</small>`
          : `<span class="pill pill--grey">Could not confirm</span><br><small style="color:var(--dim)">${esc(r.reason || '')} Visitors can still try the preview.</small>`;
    } catch (err) { out.innerHTML = `<span class="pill pill--red">${esc(err.message)}</span>`; }
  }
  $('#previewList').addEventListener('click', (e) => { const b = e.target.closest('[data-check]'); if (b) checkPreview(b.closest('[data-pid]'), true); });
  $('#previewList').addEventListener('change', async (e) => {
    const t = e.target.closest('[data-toggle-preview]');
    if (!t) return;
    const id = t.closest('[data-pid]').dataset.pid;
    try { await api(`/api/projects/${id}`, { method: 'PUT', body: json({ preview_enabled: t.checked }) }); toast(t.checked ? 'Live Preview turned on.' : 'Live Preview turned off.', 'success'); }
    catch (err) { t.checked = !t.checked; toast(err.message, 'error'); }
  });
  $('#checkAllPreviews').addEventListener('click', () => $$('#previewList [data-pid]').forEach(item => { if ($('[data-check]', item)) checkPreview(item, true); }));

  // =========================================================
  // Services
  // =========================================================
  const serviceFields = [
    { name: 'title', label: 'Service name', required: true, maxlength: 150 },
    { name: 'description', label: 'Plain-English description', type: 'textarea', rows: 4, maxlength: 1000, hint: 'Explain what the client gets, without technical jargon.' },
    { name: 'benefits', label: 'Business benefits', type: 'lines', rows: 4, hint: 'One benefit per line (up to 8). Shown as a checklist. Requires the latest database update.' },
    { name: 'icon', label: 'Icon', type: 'select', options: [{ value: 'web', label: 'Website' }, { value: 'app', label: 'Web application' }, { value: 'code', label: 'Custom software' }, { value: 'system', label: 'Business system' }, { value: 'mobile', label: 'Mobile' }, { value: 'api', label: 'API / integration' }, { value: 'support', label: 'Support / maintenance' }, { value: 'AI', label: 'AI / automation' }, { value: 'commerce', label: 'E-commerce' }], placeholderOption: 'Choose automatically from the name' },
    { name: 'display_order', label: 'Display order', type: 'number', hint: 'Lower numbers appear first.' },
    { name: 'published', label: 'Visible on website', type: 'switch', default: true }
  ];
  async function loadServices() {
    const tbody = $('#servicesTable tbody');
    tbody.innerHTML = skeletonRows(5);
    try {
      const { services } = await api('/api/services/admin/all');
      state.services = services || [];
      tbody.innerHTML = state.services.length ? state.services.map(s => `<tr>
        <td class="cell-main"><strong>${esc(s.title)}</strong><br><small style="color:var(--dim)">${esc((s.description || '').slice(0, 110))}${(s.description || '').length > 110 ? '…' : ''}</small></td>
        <td data-label="Order">${s.display_order ?? 0}</td>
        <td data-label="Visibility">${visibilityPill(s.published)}</td>
        <td data-label="Updated">${timeAgo(s.updated_at || s.created_at)}</td>
        <td class="col-actions"><div class="row-actions">${btnIcon('edit', `Edit ${s.title}`, `data-edit="${esc(s.id)}"`)}${btnIcon('trash', `Delete ${s.title}`, `data-delete="${esc(s.id)}"`, 'icon-btn--danger')}</div></td></tr>`).join('')
        : '<tr><td colspan="5" class="table-empty">No services yet.</td></tr>';
    } catch (err) { tbody.innerHTML = errorRow(5, err.message, 'services'); }
  }
  // Emoji icons from older records are not valid choices — let the name decide
  const cleanIcon = (v) => /^[\w\s-]*$/.test(v || '') ? v : '';
  $('#servicesTable').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const s = state.services.find(x => x.id === (t.dataset.edit || t.dataset.delete));
    if (!s) return;
    if (t.dataset.edit) openForm({ title: 'Edit service', fields: serviceFields, initial: { ...s, icon: cleanIcon(s.icon) }, onSubmit: async (v) => { await api(`/api/services/${s.id}`, { method: 'PUT', body: json(v) }); loadServices(); } });
    else deleteItem({ label: `“${s.title}”`, url: `/api/services/${s.id}`, after: loadServices });
  });
  $('#newServiceBtn').addEventListener('click', () => openForm({ title: 'Add service', fields: serviceFields, initial: { published: true, display_order: (state.services.length + 1) * 10 }, submitLabel: 'Add service', onSubmit: async (v) => { await api('/api/services', { method: 'POST', body: json(v) }); loadServices(); } }));

  // =========================================================
  // Company settings
  // =========================================================
  const COMPANY_SECTIONS = [
    { title: 'Company introduction', desc: 'Shown at the top of the About section.', fields: [
      { name: 'company_name', label: 'Company name', required: true },
      { name: 'address', label: 'Office address' },
      { name: 'description', label: 'Company introduction', type: 'textarea', rows: 5, full: true, hint: 'Separate paragraphs with a blank line.' }
    ] },
    { title: 'Mission, vision & values', fields: [
      { name: 'mission', label: 'Mission', type: 'textarea', full: true },
      { name: 'vision', label: 'Vision', type: 'textarea', full: true },
      { name: 'core_values', label: 'Core values', type: 'textarea', full: true, rows: 4, hint: 'One value per line. Requires the latest database update; until then the website shows values drawn from your mission.' }
    ] },
    { title: 'Founder', desc: 'The large photograph and profile in the About section.', fields: [
      { name: 'ceo_photo_url', label: 'Founder photograph', type: 'image', folder: 'company', full: true, hint: 'Portrait (4:5) photos display best.' },
      { name: 'ceo_name', label: 'Founder name' },
      { name: 'ceo_title', label: 'Founder title' },
      { name: 'ceo_bio', label: 'Founder biography', type: 'textarea', rows: 6, full: true }
    ] },
    { title: 'Company registration', desc: 'The CAC certificate is displayed exactly as uploaded — never cropped or altered.', fields: [
      { name: 'cac_number', label: 'CAC registration (RC) number' },
      { name: 'cac_document_url', label: 'Certificate of Incorporation', type: 'document', folder: 'documents', full: true, hint: 'Upload the original scan as an image or PDF.' }
    ] },
    { title: 'Contact details', fields: [
      { name: 'email', label: 'Email address', type: 'email' },
      { name: 'phone', label: 'Phone number' },
      { name: 'whatsapp', label: 'WhatsApp number', hint: 'A phone number or a wa.me link.' }
    ] },
    { title: 'Social media', fields: [
      { name: 'instagram_url', label: 'Instagram', type: 'url', placeholder: 'https://instagram.com/…' },
      { name: 'tiktok_url', label: 'TikTok', type: 'url', placeholder: 'https://tiktok.com/@…' },
      { name: 'youtube_url', label: 'YouTube', type: 'url', placeholder: 'https://youtube.com/@…' }
    ] },
    { title: 'Brand', fields: [
      { name: 'logo_url', label: 'Company logo', type: 'image', folder: 'company', full: true }
    ] }
  ];
  const companyFields = COMPANY_SECTIONS.flatMap(s => s.fields);

  async function loadCompany() {
    const wrap = $('#companySettings');
    wrap.innerHTML = '<div class="card"><span class="skeleton" style="width:50%"></span><span class="skeleton" style="width:80%"></span><span class="skeleton" style="width:65%"></span></div>';
    try {
      const { company } = await api('/api/company');
      state.company = company || {};
      const hasValues = Object.prototype.hasOwnProperty.call(state.company, 'core_values');
      wrap.innerHTML = `<form class="settings" id="companyForm" novalidate>${COMPANY_SECTIONS.map(sec => `
        <section class="settings-card"><header class="settings-card__head"><h2>${esc(sec.title)}</h2>${sec.desc ? `<p>${esc(sec.desc)}</p>` : ''}</header>
        <div class="settings-card__body">${sec.fields.filter(f => f.name !== 'core_values' || hasValues).map(f => fieldHtml(f, state.company[f.name] || '', 'cf')).join('')}</div></section>`).join('')}
        <div class="settings-actions"><a class="btn btn--ghost" href="/#about" target="_blank" rel="noopener">${icon('external')}View on website</a><button class="btn btn--primary" type="submit" id="companySave">Save all changes</button></div>
      </form>`;
      if (!hasValues) {
        wrap.querySelector('.settings-card:nth-child(2) .settings-card__body').insertAdjacentHTML('beforeend', `<p class="field__hint full">${icon('warning')} Editable core values become available after running the latest database update.</p>`);
      }
      $$('.upload', wrap).forEach(wireUpload);
      $('#companyForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fields = companyFields.filter(f => document.getElementById(`cf_${f.name}`));
        if (!validateFields(fields, 'cf')) { toast('Please fix the highlighted fields.', 'error'); return; }
        if ($$('.upload.is-uploading', wrap).length) { toast('Please wait for the upload to finish.', 'info'); return; }
        const payload = {};
        fields.forEach(f => { payload[f.name] = readField(f, 'cf'); });
        const btn = $('#companySave');
        setLoading(btn, true);
        try { const r = await api('/api/company', { method: 'PUT', body: json(payload) }); state.company = r.company; toast('Company details saved. The website is updated.', 'success'); }
        catch (err) { toast(err.message, 'error', 6000); }
        finally { setLoading(btn, false); }
      });
    } catch (err) {
      wrap.innerHTML = `<div class="error-row">${icon('warning')}${esc(err.message)}<button type="button" class="retry-btn" data-retry="company">Try again</button></div>`;
    }
  }

  // =========================================================
  // Media: asset health + library
  // =========================================================
  function checkImage(url, timeout = 15000) {
    return new Promise((resolve) => {
      const img = new Image();
      const t = setTimeout(() => { img.src = ''; resolve('slow'); }, timeout);
      img.onload = () => { clearTimeout(t); resolve(img.naturalWidth ? 'ok' : 'broken'); };
      img.onerror = () => { clearTimeout(t); resolve('broken'); };
      img.src = url;
    });
  }
  async function loadAssetHealth() {
    const box = $('#assetHealth');
    box.innerHTML = '<span class="skeleton" style="width:60%"></span>';
    const [c, p, r] = await Promise.allSettled([api('/api/company'), api('/api/projects/admin/all'), api('/api/reviews/admin/all')]);
    const company = c.status === 'fulfilled' ? c.value.company || {} : {};
    const assets = [
      { label: 'Company logo', url: company.logo_url, required: true, where: 'About the Company › Brand' },
      { label: 'Founder photograph', url: company.ceo_photo_url, required: true, where: 'About the Company › Founder' },
      { label: 'CAC Certificate of Incorporation', url: company.cac_document_url, required: true, where: 'About the Company › Registration' },
      ...(p.status === 'fulfilled' ? p.value.projects : []).map(x => ({ label: `Project: ${x.title}`, url: x.image_url, required: x.published, where: 'Manage Projects' })),
      ...(r.status === 'fulfilled' ? r.value.reviews : []).filter(x => x.client_image_url).map(x => ({ label: `Review: ${x.client_name}`, url: x.client_image_url, where: 'Client Reviews' }))
    ];
    box.innerHTML = assets.map((a, i) => {
      const u = safeUrl(a.url);
      return `<div class="asset" data-asset="${i}">${u && !isPdfUrl(u) ? `<span class="thumb"><img src="${esc(u)}" alt="" loading="lazy"></span>` : `<span class="thumb">${icon(u ? 'doc' : 'warning')}</span>`}
        <div class="asset__meta"><strong title="${esc(a.label)}">${esc(a.label)}</strong><small>${esc(a.where)}</small>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">Open file</a>` : ''}</div>
        <span data-status>${u ? '<span class="pill pill--grey">Checking…</span>' : a.required ? '<span class="pill pill--red">Missing</span>' : '<span class="pill pill--grey">None</span>'}</span></div>`;
    }).join('') || '<p class="empty">No images are referenced yet.</p>';
    assets.forEach(async (a, i) => {
      const u = safeUrl(a.url);
      if (!u) return;
      const el = $(`[data-asset="${i}"] [data-status]`, box);
      if (isPdfUrl(u)) { el.innerHTML = '<span class="pill pill--blue">PDF — open to verify</span>'; return; }
      const res = await checkImage(u);
      el.innerHTML = res === 'ok' ? '<span class="pill pill--green">Working</span>' : res === 'slow' ? '<span class="pill pill--amber">Slow to load</span>' : '<span class="pill pill--red">Broken link</span>';
    });
  }
  $('#rerunAssetCheck').addEventListener('click', loadAssetHealth);

  const mState = { page: 1, total: 0, assets: [], unavailable: false };
  function loadMedia() { loadAssetHealth(); loadLibrary(); }
  async function loadLibrary() {
    const grid = $('#mediaGrid');
    grid.innerHTML = Array.from({ length: 4 }).map(() => '<div class="media-tile"><div class="media-tile__thumb"></div><div class="media-tile__body"><span class="skeleton"></span></div></div>').join('');
    const params = new URLSearchParams({ page: mState.page, limit: 24 });
    if ($('#mType').value) params.set('type', $('#mType').value);
    if ($('#mSearch').value.trim()) params.set('search', $('#mSearch').value.trim());
    try {
      const data = await api(`/api/media?${params}`);
      mState.unavailable = false;
      mState.assets = data.assets || [];
      mState.total = data.total || 0;
      grid.innerHTML = mState.assets.length ? mState.assets.map(a => {
        const isImg = a.mime_type.startsWith('image/');
        return `<article class="media-tile" data-mid="${esc(a.id)}">
          <button type="button" class="media-tile__thumb" data-open aria-label="Preview ${esc(a.file_name)}">${isImg && a.url ? `<img src="${esc(a.url)}" alt="${esc(a.description || '')}" loading="lazy" data-thumb>` : icon(isImg ? 'lock' : 'doc')}
            ${a.is_private ? `<span class="media-tile__badge">${icon('lock')}Private</span>` : ''}</button>
          <div class="media-tile__body">
            <span class="media-tile__name" title="${esc(a.file_name)}">${esc(a.file_name)}</span>
            <span class="media-tile__desc ${a.description ? '' : 'is-missing'}">${esc(a.description || 'No description (alt text) yet')}</span>
            <span class="media-tile__meta">${a.mime_type === 'application/pdf' ? 'PDF' : a.mime_type.split('/')[1].toUpperCase()} · ${fmtSize(a.size_bytes)} · ${fmtDate(a.created_at)}</span>
            <div class="media-tile__actions">
              ${btnIcon('edit', 'Edit description', 'data-describe')}
              ${btnIcon('swap', 'Replace file', 'data-replace')}
              ${a.url ? btnIcon('copy', 'Copy web address', 'data-copy') : ''}
              ${isAdmin() ? btnIcon('trash', 'Delete file', 'data-remove', 'icon-btn--danger') : ''}
            </div>
          </div></article>`;
      }).join('') : `<div class="empty" style="grid-column:1/-1">${icon('media')}<p>${$('#mSearch').value || $('#mType').value ? 'No files match your search.' : 'No files uploaded yet.'}</p></div>`;
      const pages = Math.ceil(mState.total / 24);
      $('#mediaPager').innerHTML = pages > 1 ? `<span>Page ${mState.page} of ${pages}</span><div><button class="btn btn--ghost btn--sm" data-mpage="-1" ${mState.page === 1 ? 'disabled' : ''}>Previous</button><button class="btn btn--ghost btn--sm" data-mpage="1" ${mState.page >= pages ? 'disabled' : ''}>Next</button></div>` : '';
    } catch (err) {
      mState.unavailable = err.code === 'MIGRATION_REQUIRED';
      grid.innerHTML = `<div class="notice ${mState.unavailable ? 'notice--warn' : ''}" style="grid-column:1/-1">${icon('warning')}<div>${esc(err.message)}${mState.unavailable ? ' Uploads from the project and company forms still work.' : ''}</div></div>`;
      $('#mediaPager').innerHTML = '';
    }
  }
  $('#mType').addEventListener('change', () => { mState.page = 1; loadLibrary(); });
  $('#mSearch').addEventListener('input', debounce(() => { mState.page = 1; loadLibrary(); }, 300));
  $('#mediaPager').addEventListener('click', (e) => { const b = e.target.closest('[data-mpage]'); if (b) { mState.page += Number(b.dataset.mpage); loadLibrary(); } });

  $('#mediaGrid').addEventListener('click', async (e) => {
    const tile = e.target.closest('[data-mid]');
    if (!tile) return;
    const a = mState.assets.find(x => x.id === tile.dataset.mid);
    const btn = e.target.closest('button');
    if (!a || !btn) return;
    if (btn.hasAttribute('data-open')) openFile(a);
    if (btn.hasAttribute('data-describe')) openForm({ title: 'Edit description', fields: [{ name: 'description', label: 'Description / alt text', type: 'textarea', rows: 3, maxlength: 300, hint: 'Describe what is in the image for people using screen readers and for search engines.' }], initial: a, onSubmit: async (v) => { await api(`/api/media/${a.id}`, { method: 'PUT', body: json(v) }); loadLibrary(); } });
    if (btn.hasAttribute('data-copy')) { try { await navigator.clipboard.writeText(a.url); toast('Web address copied.', 'success', 2500); } catch { toast(a.url, 'info', 8000); } }
    if (btn.hasAttribute('data-remove')) deleteItem({ label: `“${a.file_name}”`, url: `/api/media/${a.id}`, after: loadLibrary });
    if (btn.hasAttribute('data-replace')) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = a.mime_type === 'application/pdf' ? 'application/pdf' : IMAGE_TYPES.join(',');
      input.addEventListener('change', async () => {
        const f = input.files[0];
        if (!f) return;
        if (f.size > (f.type === 'application/pdf' ? 10 : 5) * 1048576) { toast('That file is too large.', 'error'); return; }
        setLoading(btn, true, '');
        try { await uploadFile(f, {}, null, `/api/media/${a.id}/replace`); toast('File replaced. Pages using it now show the new version (allow a few minutes for caches).', 'success', 6000); loadLibrary(); }
        catch (err) { toast(err.message, 'error'); setLoading(btn, false); }
      });
      input.click();
    }
  });

  async function openFile(a) {
    const body = $('#fileModalBody');
    $('#fileModalTitle').textContent = a.file_name;
    body.innerHTML = '<span class="spinner"></span>';
    openDialog($('#fileModal'));
    try {
      const { url } = a.is_private ? await api(`/api/media/${a.id}/open`) : { url: a.url };
      body.innerHTML = a.mime_type === 'application/pdf'
        ? `<iframe src="${esc(url)}" title="${esc(a.file_name)}"></iframe>`
        : `<img src="${esc(url)}" alt="${esc(a.description || '')}">`;
    } catch (err) { body.innerHTML = `<div class="error-row">${esc(err.message)}</div>`; }
  }

  $('#uploadMediaBtn').addEventListener('click', () => {
    if (mState.unavailable) { toast('The media library needs the latest database update first (see the notice).', 'error', 6000); return; }
    $('#formModalTitle').textContent = 'Upload file';
    const form = $('#formModalForm');
    form.innerHTML = `
      <div class="field"><label for="up_file">File <span class="req">*</span></label><input type="file" id="up_file" accept="${DOC_TYPES.join(',')}" required><p class="field__hint">JPEG, PNG, WEBP or GIF images up to 5MB, or PDF documents up to 10MB.</p></div>
      <div class="field"><label for="up_desc">Description / alt text</label><textarea id="up_desc" rows="3" maxlength="300"></textarea></div>
      <div class="field"><label for="up_folder">Folder</label><select id="up_folder"><option value="media">General</option><option value="company">Company photos &amp; logos</option><option value="documents">Documents</option><option value="projects">Project images</option></select></div>
      <label class="switch"><input type="checkbox" id="up_private"><span class="switch__track"></span><span class="switch__text"><strong>Private document</strong><small>Stored in a private bucket and only viewable by signed-in admins via short-lived links. Never use for files shown on the website.</small></span></label>
      <div class="upload__bar" id="up_bar" hidden><span></span></div><p class="upload__status" id="up_status"></p>`;
    const save = $('#formModalSave');
    save.textContent = 'Upload';
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = $('#up_file').files[0];
      const status = $('#up_status');
      if (!f) { status.textContent = 'Choose a file to upload.'; status.className = 'upload__status is-error'; return; }
      if (!DOC_TYPES.includes(f.type)) { status.textContent = 'Unsupported file type.'; status.className = 'upload__status is-error'; return; }
      if (f.size > (f.type === 'application/pdf' ? 10 : 5) * 1048576) { status.textContent = 'That file is too large.'; status.className = 'upload__status is-error'; return; }
      setLoading(save, true, 'Uploading…');
      $('#up_bar').hidden = false;
      try {
        await uploadFile(f, { folder: $('#up_folder').value, description: $('#up_desc').value.trim(), private: $('#up_private').checked ? 'true' : 'false' }, (pct) => { $('#up_bar span').style.width = `${pct}%`; status.textContent = `Uploading… ${pct}%`; status.className = 'upload__status'; });
        closeDialog(formModal);
        toast('File uploaded.', 'success');
        mState.page = 1;
        loadLibrary();
      } catch (err) { status.textContent = err.message; status.className = 'upload__status is-error'; }
      finally { setLoading(save, false); }
    };
    openDialog(formModal);
  });

  // =========================================================
  // SHEREBOY BLOG connection (read-only — articles are managed on SHEREBOY BLOG)
  // =========================================================
  function fmtDateTime(iso) {
    return iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  }
  function renderBlogConnection(s) {
    const conn = s.connection || {};
    const live = conn.ok === true;
    const stat = (label, value, sub = '') => `<div class="blog-conn__stat"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const blogUrl = safeUrl(s.blogUrl);
    if (blogUrl) $('#blogOpenBtn').href = `${blogUrl}/`;
    $('#blogConnection').innerHTML = `
      <div class="blog-conn__status ${live ? 'is-ok' : 'is-down'}">
        <span class="blog-conn__dot" aria-hidden="true"></span>
        <div>
          <strong>${live ? 'Connected to SHEREBOY BLOG' : 'SHEREBOY BLOG is not responding'}</strong>
          <p>${live
    ? `The public articles API answered in ${conn.responseMs} ms.`
    : `${esc(conn.error || 'The connection check failed.')} The website keeps working${s.cachedArticles ? ' and shows the last saved articles' : ''} until the blog is back.`}</p>
        </div>
      </div>
      <div class="blog-conn__grid">
        ${stat('Blog platform', 'SHEREBOY BLOG', blogUrl ? `<a href="${esc(blogUrl)}/" target="_blank" rel="noopener noreferrer">${esc(blogUrl.replace(/^https?:\/\//, ''))}</a>` : '')}
        ${stat('API availability', live ? '<span class="pill pill--green">Available</span>' : '<span class="pill pill--red">Unavailable</span>', `<code>${esc((s.apiUrl || '').replace(/^https?:\/\//, ''))}</code>`)}
        ${stat('Published articles', live && conn.publishedCount !== null ? conn.publishedCount : (s.totalPublished ?? '—'), live ? 'Live count from the blog' : 'From the last successful sync')}
        ${stat('Last successful sync', s.lastSuccessAt ? timeAgo(s.lastSuccessAt) : 'Never', fmtDateTime(s.lastSuccessAt))}
        ${stat('Last sync error', s.lastError ? '<span class="pill pill--red">Error</span>' : '<span class="pill pill--green">None</span>', s.lastError ? `${esc(s.lastError)} · ${fmtDateTime(s.lastErrorAt)}` : '')}
        ${stat('Automatic updates', s.webhookConfigured ? 'Instant + every few minutes' : `Every ${Math.round(s.cacheTtlSeconds / 60)} minutes`, s.webhookConfigured ? 'Webhook from SHEREBOY BLOG is configured' : 'Set BLOG_WEBHOOK_SECRET to enable instant updates')}
      </div>`;
  }

  async function loadBlogConnection() {
    $('#blogConnection').innerHTML = '<div class="card"><span class="skeleton" style="width:40%"></span><span class="skeleton" style="width:70%"></span></div>';
    $('#blogArticles').innerHTML = '<span class="skeleton" style="width:60%"></span>';
    try {
      const [status, feed] = await Promise.all([api('/api/blog-feed/admin/status'), api('/api/blog-feed')]);
      renderBlogConnection(status);
      renderBlogArticles(feed);
    } catch (err) {
      $('#blogConnection').innerHTML = `<div class="error-row">${icon('warning')}${esc(err.message)}<button type="button" class="retry-btn" data-retry="blog">Try again</button></div>`;
      $('#blogArticles').innerHTML = '';
    }
  }

  function renderBlogArticles(feed) {
    const list = (feed && feed.articles) || [];
    $('#blogArticles').innerHTML = list.length
      ? `<ul class="blog-list">${list.map(a => `<li>
          ${thumb(a.image && a.image.url)}
          <div><a href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer"><strong>${esc(a.title)}</strong></a>
          <small>${[a.category && a.category.name, a.author && a.author.name, fmtDate(a.publishedAt)].filter(Boolean).map(esc).join(' · ')}${a.isFeatured ? ' · <span class="pill pill--blue">Featured</span>' : ''}</small></div>
        </li>`).join('')}</ul>`
      : `<div class="empty">${icon('blog')}<p>${feed && feed.status === 'unavailable' ? 'No articles can be shown until SHEREBOY BLOG is reachable.' : 'No published articles yet. Publish an article on SHEREBOY BLOG and it will appear here.'}</p></div>`;
  }

  $('#blogRefreshBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true, 'Refreshing…');
    try {
      await api('/api/blog-feed/admin/refresh', { method: 'POST' });
      toast('Articles refreshed from SHEREBOY BLOG.', 'success');
    } catch (err) {
      toast(`Refresh failed: ${err.message}`, 'error', 6000);
    } finally {
      setLoading(btn, false);
      loadBlogConnection();
    }
  });

  // =========================================================
  // Affiliate integration (read-only — products are managed on SHEREBOY AFFILIATE CONCEPT)
  // =========================================================
  function fmtNaira(amount, currency) {
    if (typeof amount !== 'number') return '—';
    try { return new Intl.NumberFormat('en-NG', { style: 'currency', currency: currency || 'NGN', maximumFractionDigits: 0 }).format(amount); } catch { return String(amount); }
  }
  function renderAffiliateConnection(s) {
    const conn = s.connection || {};
    const live = conn.ok === true;
    const stat = (label, value, sub = '') => `<div class="blog-conn__stat"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const siteUrl = safeUrl(s.siteUrl);
    if (siteUrl) $('#affOpenBtn').href = `${siteUrl}/`;
    const issues = [
      s.productsWithoutImage ? `${s.productsWithoutImage} product${s.productsWithoutImage === 1 ? ' has' : 's have'} no working image` : '',
      s.productsWithoutDestination ? `${s.productsWithoutDestination} product${s.productsWithoutDestination === 1 ? ' has' : 's have'} no valid link` : ''
    ].filter(Boolean);
    $('#affConnection').innerHTML = `
      <div class="blog-conn__status ${live ? 'is-ok' : 'is-down'}">
        <span class="blog-conn__dot" aria-hidden="true"></span>
        <div>
          <strong>${live ? 'Connected to SHEREBOY AFFILIATE CONCEPT' : 'SHEREBOY AFFILIATE CONCEPT is not responding'}</strong>
          <p>${live
    ? `The public products API answered in ${conn.responseMs} ms.`
    : `${esc(conn.error || 'The connection check failed.')} The website keeps working${s.cachedProducts ? ' and shows the last saved products' : ''} until the platform is back.`}</p>
        </div>
      </div>
      <div class="blog-conn__grid">
        ${stat('Affiliate platform', 'SHEREBOY AFFILIATE CONCEPT', siteUrl ? `<a href="${esc(siteUrl)}/" target="_blank" rel="noopener">${esc(siteUrl.replace(/^https?:\/\//, ''))}</a>` : '')}
        ${stat('API availability', live ? '<span class="pill pill--green">Available</span>' : '<span class="pill pill--red">Unavailable</span>', `<code>${esc((s.apiUrl || '').replace(/^https?:\/\//, ''))}</code>`)}
        ${stat('Available products', live && conn.availableProducts !== null ? conn.availableProducts : s.cachedProducts, live ? `Live count · ${conn.totalProducts ?? '—'} in total on the platform` : 'From the last successful sync')}
        ${stat('Featured products', live && conn.featuredProducts !== null ? conn.featuredProducts : s.cachedFeatured, 'Marked as featured on the platform')}
        ${stat('Last successful sync', s.lastSuccessAt ? timeAgo(s.lastSuccessAt) : 'Never', fmtDateTime(s.lastSuccessAt))}
        ${stat('Last sync error', s.lastError ? '<span class="pill pill--red">Error</span>' : '<span class="pill pill--green">None</span>', s.lastError ? `${esc(s.lastError)} · ${fmtDateTime(s.lastErrorAt)}` : '')}
        ${stat('Automatic updates', s.webhookConfigured ? 'Instant + every few minutes' : `Every ${Math.round(s.cacheTtlSeconds / 60)} minutes`, s.webhookConfigured ? 'Webhook from the affiliate platform is configured' : 'Set AFFILIATE_WEBHOOK_SECRET to enable instant updates')}
        ${stat('Data quality', !s.lastSuccessAt ? '<span class="pill pill--grey">Not checked yet</span>' : (issues.length ? '<span class="pill pill--amber">Needs attention</span>' : '<span class="pill pill--green">Good</span>'), !s.lastSuccessAt ? 'Available after the first successful sync' : (issues.length ? `${issues.join(' · ')} — fix on the affiliate website` : 'Every product has an image and a link'))}
      </div>`;
  }
  function renderAffiliateProducts(feed) {
    const list = (feed && feed.products) || [];
    $('#affProducts').innerHTML = list.length
      ? `<ul class="blog-list">${list.map(p => `<li>
          ${thumb(p.image && p.image.url)}
          <div>${p.url ? `<a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener"><strong>${esc(p.name)}</strong></a>` : `<strong>${esc(p.name)}</strong> <span class="pill pill--red">No valid link</span>`}
          <small>${[p.category && p.category.name, fmtNaira(p.price && p.price.current, p.price && p.price.currency)].filter(Boolean).map(esc).join(' · ')}${p.isFeatured ? ' · <span class="pill pill--blue">Featured</span>' : ''}${p.isDeal ? ' · <span class="pill pill--amber">Deal</span>' : ''}${p.image ? '' : ' · <span class="pill pill--grey">No image</span>'}</small></div>
        </li>`).join('')}</ul>`
      : `<div class="empty">${icon('cart')}<p>${feed && feed.status === 'unavailable' ? 'No products can be shown until SHEREBOY AFFILIATE CONCEPT is reachable.' : 'No available products yet. Add products on SHEREBOY AFFILIATE CONCEPT and they will appear here.'}</p></div>`;
  }
  async function loadAffiliateIntegration() {
    $('#affConnection').innerHTML = '<div class="card"><span class="skeleton" style="width:40%"></span><span class="skeleton" style="width:70%"></span></div>';
    $('#affProducts').innerHTML = '<span class="skeleton" style="width:60%"></span>';
    try {
      const [status, feed] = await Promise.all([api('/api/affiliate-feed/admin/status'), api('/api/affiliate-feed/products?pageSize=24')]);
      renderAffiliateConnection(status);
      renderAffiliateProducts(feed);
    } catch (err) {
      $('#affConnection').innerHTML = `<div class="error-row">${icon('warning')}${esc(err.message)}<button type="button" class="retry-btn" data-retry="affiliate">Try again</button></div>`;
      $('#affProducts').innerHTML = '';
    }
  }
  $('#affRefreshBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true, 'Refreshing…');
    try {
      await api('/api/affiliate-feed/admin/refresh', { method: 'POST' });
      toast('Products refreshed from SHEREBOY AFFILIATE CONCEPT.', 'success');
    } catch (err) {
      toast(`Refresh failed: ${err.message}`, 'error', 6000);
    } finally {
      setLoading(btn, false);
      loadAffiliateIntegration();
    }
  });

  // =========================================================
  // Reviews
  // =========================================================
  const reviewFields = [
    { name: 'client_name', label: 'Client name', required: true, maxlength: 150 },
    { name: 'client_position', label: 'Position / company', maxlength: 150 },
    { name: 'review_text', label: 'Review (as written by the client)', type: 'textarea', rows: 5, required: true, maxlength: 2000 },
    { name: 'client_image_url', label: 'Client photo (with permission)', type: 'image', folder: 'reviews' },
    { name: 'rating', label: 'Rating', type: 'select', options: [5, 4, 3, 2, 1].map(n => ({ value: n, label: `${n} star${n > 1 ? 's' : ''}` })) },
    { name: 'published', label: 'Visible on website', type: 'switch' },
    { name: 'featured', label: 'Featured review', type: 'switch' }
  ];
  async function loadReviews() {
    const tbody = $('#reviewsTable tbody');
    tbody.innerHTML = skeletonRows(5);
    try {
      const { reviews } = await api('/api/reviews/admin/all');
      state.reviews = reviews || [];
      tbody.innerHTML = state.reviews.length ? state.reviews.map(r => `<tr>
        <td class="cell-main"><div class="row-title">${thumb(r.client_image_url, true)}<div><strong>${esc(r.client_name)}</strong><small>${esc(r.client_position || '')}</small></div></div></td>
        <td data-label="Rating"><span class="star-rating" aria-label="${r.rating} out of 5">${icon('star').repeat(r.rating || 5)}</span></td>
        <td data-label="Featured">${r.featured ? '<span class="pill pill--blue">Featured</span>' : '—'}</td>
        <td data-label="Visibility">${visibilityPill(r.published)}</td>
        <td class="col-actions"><div class="row-actions">${btnIcon('edit', `Edit review from ${r.client_name}`, `data-edit="${esc(r.id)}"`)}${btnIcon('trash', `Delete review from ${r.client_name}`, `data-delete="${esc(r.id)}"`, 'icon-btn--danger')}</div></td></tr>`).join('')
        : '<tr><td colspan="5" class="table-empty">No reviews yet.</td></tr>';
    } catch (err) { tbody.innerHTML = errorRow(5, err.message, 'reviews'); }
  }
  $('#reviewsTable').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const r = state.reviews.find(x => x.id === (t.dataset.edit || t.dataset.delete));
    if (!r) return;
    if (t.dataset.edit) openForm({ title: 'Edit review', fields: reviewFields, initial: r, onSubmit: async (v) => { await api(`/api/reviews/${r.id}`, { method: 'PUT', body: json(v) }); loadReviews(); } });
    else deleteItem({ label: `the review from ${r.client_name}`, url: `/api/reviews/${r.id}`, after: loadReviews });
  });
  $('#newReviewBtn').addEventListener('click', () => openForm({ title: 'Add review', fields: reviewFields, initial: { rating: 5, published: false }, submitLabel: 'Add review', onSubmit: async (v) => { await api('/api/reviews', { method: 'POST', body: json(v) }); loadReviews(); } }));

  // =========================================================
  // Messages
  // =========================================================
  let msgFilter = 'all';
  async function loadMessages() {
    const inbox = $('#messagesInbox');
    inbox.innerHTML = '<div class="inbox__item"><span></span><div><span class="skeleton" style="width:40%"></span><br><span class="skeleton" style="width:80%"></span></div></div>'.repeat(3);
    try {
      const { messages } = await api('/api/contact/admin/all');
      state.messages = messages || [];
      updateUnread();
      renderMessages();
    } catch (err) { inbox.innerHTML = `<div class="error-row">${icon('warning')}${esc(err.message)}<button type="button" class="retry-btn" data-retry="messages">Try again</button></div>`; }
  }
  function renderMessages() {
    const q = $('#msgSearch').value.trim().toLowerCase();
    const list = state.messages.filter(m => (msgFilter === 'all' || (msgFilter === 'unread' ? !m.read : m.read)) &&
      (!q || [m.name, m.email, m.subject, m.message, m.phone].join(' ').toLowerCase().includes(q)));
    $('#messagesInbox').innerHTML = list.length ? list.map(m => `
      <div class="inbox__item ${m.read ? '' : 'is-unread'}" data-open="${esc(m.id)}" tabindex="0" role="button" aria-label="${m.read ? '' : 'Unread. '}Message from ${esc(m.name)}">
        <span class="inbox__dot" aria-hidden="true"></span>
        <div class="inbox__main">
          <div class="inbox__top"><span class="inbox__from">${esc(m.name)}</span><span class="inbox__time">${timeAgo(m.created_at)}</span></div>
          <p class="inbox__subject">${esc(m.subject || '(No subject)')}</p>
          <p class="inbox__preview">${esc(m.message)}</p>
        </div>
        ${btnIcon('trash', `Delete message from ${m.name}`, `data-del="${esc(m.id)}"`, 'icon-btn--danger')}
      </div>`).join('')
      : `<div class="empty">${icon('inbox')}<p>${state.messages.length ? 'No messages match.' : 'No messages yet. Enquiries from the website will appear here.'}</p></div>`;
  }
  $('#msgSearch').addEventListener('input', debounce(renderMessages, 150));
  $$('[data-msg-filter]').forEach(b => b.addEventListener('click', () => {
    msgFilter = b.dataset.msgFilter;
    $$('[data-msg-filter]').forEach(x => x.classList.toggle('is-active', x === b));
    renderMessages();
  }));
  $('#messagesInbox').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); const m = state.messages.find(x => x.id === del.dataset.del); deleteItem({ label: `the message from ${m.name}`, url: `/api/contact/${m.id}`, after: loadMessages }); return; }
    const item = e.target.closest('[data-open]');
    if (item) openMessage(item.dataset.open);
  });
  $('#messagesInbox').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-open]')) openMessage(e.target.dataset.open); });

  async function openMessage(id) {
    if (!state.messages.length) { try { state.messages = (await api('/api/contact/admin/all')).messages || []; } catch { /* handled below */ } }
    const m = state.messages.find(x => x.id === id);
    if (!m) { toast('That message could not be found.', 'error'); return; }
    const phone = String(m.phone || '').replace(/[^\d+]/g, '');
    const wa = phone ? phone.replace(/^\+/, '').replace(/^0/, '234') : '';
    $('#messageModalTitle').textContent = m.subject || 'Message';
    $('#messageModalBody').innerHTML = `
      <dl class="msg-meta">
        <dt>From</dt><dd>${esc(m.name)}</dd>
        <dt>Email</dt><dd><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></dd>
        ${m.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(phone)}">${esc(m.phone)}</a></dd>` : ''}
        <dt>Received</dt><dd>${new Date(m.created_at).toLocaleString('en-GB')}</dd>
        <dt>Status</dt><dd id="msgStatus">${m.read ? '<span class="pill pill--grey">Read</span>' : '<span class="pill pill--blue">Unread</span>'}</dd>
      </dl>
      <div class="msg-body">${esc(m.message)}</div>
      <div class="msg-actions">
        <a class="btn btn--primary btn--sm" href="mailto:${esc(m.email)}?subject=${encodeURIComponent(`Re: ${m.subject || 'Your enquiry to SHEREBOY TECH LTD'}`)}">${icon('messages')}Reply by email</a>
        ${wa ? `<a class="btn btn--ghost btn--sm" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        <button type="button" class="btn btn--ghost btn--sm" id="msgToggle">${m.read ? 'Mark as unread' : 'Mark as read'}</button>
        <button type="button" class="btn btn--ghost btn--sm" id="msgDelete">${icon('trash')}Delete</button>
      </div>`;
    openDialog($('#messageModal'));
    const setRead = async (read) => {
      await api(`/api/contact/${m.id}/read`, { method: 'PUT', body: json({ read }) });
      m.read = read;
      $('#msgStatus').innerHTML = read ? '<span class="pill pill--grey">Read</span>' : '<span class="pill pill--blue">Unread</span>';
      $('#msgToggle').textContent = read ? 'Mark as unread' : 'Mark as read';
      updateUnread();
      if (!$('#view-messages').hidden) renderMessages();
    };
    $('#msgToggle').addEventListener('click', async (e) => { const b = e.currentTarget; setLoading(b, true); try { await setRead(!m.read); } catch (err) { toast(err.message, 'error'); } finally { setLoading(b, false); b.textContent = m.read ? 'Mark as unread' : 'Mark as read'; } });
    $('#msgDelete').addEventListener('click', () => { closeDialog($('#messageModal')); deleteItem({ label: `the message from ${m.name}`, url: `/api/contact/${m.id}`, after: loadMessages }); });
    if (!m.read) setRead(true).catch(() => { /* will sync next load */ });
  }

  // =========================================================
  // Administrator accounts (admins only — enforced server-side too)
  // =========================================================
  let accounts = [];
  async function loadAccounts() {
    const tbody = $('#accountsTable tbody');
    tbody.innerHTML = skeletonRows(4, 2);
    try {
      const data = await api('/api/admin/users');
      accounts = data.users || [];
      tbody.innerHTML = accounts.map(u => {
        const env = u.source === 'environment';
        const self = u.id === data.currentUserId;
        return `<tr>
          <td class="cell-main"><div class="row-title"><span class="avatar">${esc(u.username.slice(0, 1))}</span><div><strong>${esc(u.username)}${self ? ' <span class="pill pill--blue">You</span>' : ''}</strong><small>${env ? 'Main account (set in server environment variables)' : 'Dashboard account'}</small></div></div></td>
          <td data-label="Role"><span class="pill ${u.role === 'admin' ? 'pill--green' : 'pill--grey'}">${u.role === 'admin' ? 'Administrator' : 'Editor'}</span></td>
          <td data-label="Created">${env ? '—' : fmtDate(u.created_at)}</td>
          <td class="col-actions"><div class="row-actions">${env ? '' : `${btnIcon('edit', `Edit ${u.username}`, `data-edit="${esc(u.id)}"`)}${self ? '' : btnIcon('trash', `Delete ${u.username}`, `data-delete="${esc(u.id)}"`, 'icon-btn--danger')}`}</div></td></tr>`;
      }).join('') || '<tr><td colspan="4" class="table-empty">No accounts.</td></tr>';
    } catch (err) { tbody.innerHTML = errorRow(4, err.message, 'accounts'); }
  }
  const pwHint = 'At least 10 characters, with letters and numbers.';
  const pwValidate = (v) => v && (v.length < 10 || !/[a-z]/i.test(v) || !/\d/.test(v)) ? pwHint : '';
  const roleField = { name: 'role', label: 'Role', type: 'select', options: [{ value: 'editor', label: 'Editor — website content only' }, { value: 'admin', label: 'Administrator — full access' }] };
  $('#newAccountBtn').addEventListener('click', () => openForm({
    title: 'Add administrator account',
    fields: [
      { name: 'username', label: 'Username', required: true, hint: '3–40 characters: letters, numbers, dot, dash or underscore.', validate: (v) => /^[a-zA-Z0-9._-]{3,40}$/.test(v) ? '' : 'Use 3–40 letters, numbers, dots, dashes or underscores.' },
      { name: 'password', label: 'Password', type: 'password', required: true, hint: pwHint, validate: pwValidate },
      roleField
    ],
    initial: { role: 'editor' },
    submitLabel: 'Create account',
    onSubmit: async (v) => { await api('/api/admin/users', { method: 'POST', body: json(v) }); loadAccounts(); }
  }));
  $('#accountsTable').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const u = accounts.find(x => x.id === (t.dataset.edit || t.dataset.delete));
    if (!u) return;
    if (t.dataset.edit) openForm({
      title: `Edit ${u.username}`,
      fields: [roleField, { name: 'password', label: 'New password (optional)', type: 'password', hint: `Leave blank to keep the current password. ${pwHint}`, validate: pwValidate }],
      initial: { role: u.role },
      onSubmit: async (v) => { const body = { role: v.role }; if (v.password) body.password = v.password; await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: json(body) }); loadAccounts(); }
    });
    else deleteItem({ label: `the account “${u.username}”`, url: `/api/admin/users/${u.id}`, after: loadAccounts });
  });

  // =========================================================
  // Security & activity log
  // =========================================================
  const logState = { page: 1, filter: '' };
  async function loadActivity() {
    const tbody = $('#activityTable tbody');
    tbody.innerHTML = skeletonRows(3, 6);
    try {
      const data = await api(`/api/admin/activity?page=${logState.page}&limit=25${logState.filter ? `&filter=${logState.filter}` : ''}`);
      const rows = data.activity || [];
      tbody.innerHTML = rows.length ? rows.map(a => `<tr>
        <td data-label="When" title="${esc(new Date(a.created_at).toLocaleString('en-GB'))}">${timeAgo(a.created_at)}</td>
        <td data-label="Event"><span class="pill ${a.action === 'login_failed' ? 'pill--red' : /delete/.test(a.action) ? 'pill--amber' : /login|logout/.test(a.action) ? 'pill--blue' : 'pill--grey'}">${esc(actionLabel(a.action))}</span></td>
        <td data-label="Details">${esc(a.details || '')}</td></tr>`).join('')
        : '<tr><td colspan="3" class="table-empty">No activity recorded.</td></tr>';
      const pages = Math.ceil((data.total || 0) / 25);
      $('#activityPager').innerHTML = pages > 1 ? `<span>Page ${logState.page} of ${pages} · ${data.total} events</span><div><button class="btn btn--ghost btn--sm" data-lpage="-1" ${logState.page === 1 ? 'disabled' : ''}>Newer</button><button class="btn btn--ghost btn--sm" data-lpage="1" ${logState.page >= pages ? 'disabled' : ''}>Older</button></div>` : '';
    } catch (err) { tbody.innerHTML = errorRow(3, err.message, 'security'); }
  }
  $('#activityPager').addEventListener('click', (e) => { const b = e.target.closest('[data-lpage]'); if (b) { logState.page += Number(b.dataset.lpage); loadActivity(); } });
  $$('[data-log-filter]').forEach(b => b.addEventListener('click', () => {
    logState.filter = b.dataset.logFilter;
    logState.page = 1;
    $$('[data-log-filter]').forEach(x => x.classList.toggle('is-active', x === b));
    loadActivity();
  }));

  boot();
})();
