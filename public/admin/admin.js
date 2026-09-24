// public/admin/admin.js
// Admin dashboard logic. Every write operation is also re-validated
// server-side — this file only handles UI + API calls, with clear
// loading / success / error feedback at every step.

const loginScreen = document.getElementById('loginScreen');
const dashScreen = document.getElementById('dashScreen');

// =========================================================
// Icons
// =========================================================
const ICONS = {
  warning: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3.5l9.5 16.5H2.5L12 3.5z" stroke-linejoin="round"></path><path d="M12 10v4.5" stroke-linecap="round"></path><circle cx="12" cy="17.5" r="0.9" fill="currentColor" stroke="none"></circle></svg>',
  star: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.2 6.8.7-5.1 4.6 1.5 6.7L12 17.4 5.9 20.7l1.5-6.7-5.1-4.6 6.8-.7L12 2.5z"></path></svg>',
  image: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"></rect><circle cx="9" cy="10" r="1.8"></circle><path d="M21 16.5l-5.2-5.2a2 2 0 0 0-2.8 0L5 19" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  edit: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  trash: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  eye: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" stroke-linejoin="round"></path><circle cx="12" cy="12" r="3"></circle></svg>',
  eyeOff: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 3l18 18M10.6 5.6A10.6 10.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.6 15.6 0 0 1-3.4 4.1M6.6 6.6C4 8.3 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.4 0 2.6-.3 3.7-.8M9.5 9.6a3 3 0 0 0 4.1 4.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  star2: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 2.5l2.9 6.2 6.8.7-5.1 4.6 1.5 6.7L12 17.4 5.9 20.7l1.5-6.7-5.1-4.6 6.8-.7L12 2.5z" stroke-linejoin="round"></path></svg>',
  mail: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3.5 6l8.5 7 8.5-7" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  mailOpen: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 19V9.5l9-6 9 6V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" stroke-linejoin="round"></path><path d="M3 9.5l9 6 9-6" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  inbox: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 12h4l1.5 3h5L16 12h4M4 12l1.5-7A1 1 0 0 1 6.47 4h11.06a1 1 0 0 1 .97 1L20 12M4 12v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6" stroke-linejoin="round"></path></svg>'
};
function starRating(n) {
  const r = Math.min(Math.max(parseInt(n, 10) || 0, 0), 5);
  return `<span class="star-rating">${ICONS.star.repeat(r)}</span>`;
}

// =========================================================
// Toast notifications
// =========================================================
const toastStack = document.getElementById('toastStack');
function showToast(message, type = 'info', duration = 4500) {
  if (!toastStack) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  toastStack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// =========================================================
// Button loading-state helper
// =========================================================
function setButtonLoading(btn, loading, loadingText = 'Please wait…') {
  if (!btn) return;
  if (loading) {
    btn.dataset.originalHtml = btn.dataset.originalHtml || btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.innerHTML = `<span class="spinner"></span> ${loadingText}`;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.innerHTML = btn.dataset.originalHtml || btn.innerHTML;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function pill(bool) { return `<span class="pill ${bool ? 'pill--yes' : 'pill--no'}">${bool ? 'Yes' : 'No'}</span>`; }
function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

function skeletonRows(cols, count = 4) {
  return Array.from({ length: count }).map(() => `
    <tr class="skeleton-row">${Array.from({ length: cols }).map(() => `<td><div class="skeleton" style="width:${60 + Math.random() * 30}%"></div></td>`).join('')}</tr>
  `).join('');
}

function errorRowHtml(cols, message, retryFnName) {
  return `<tr><td colspan="${cols}"><div class="error-row">${ICONS.warning} ${escapeHtml(message)} <button class="retry-btn" onclick="${retryFnName}()">Retry</button></div></td></tr>`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}

// =========================================================
// Auth
// =========================================================
async function checkSession() {
  try {
    const { authenticated, user } = await api('/api/auth/session');
    if (authenticated) {
      loginScreen.hidden = true;
      dashScreen.hidden = false;
      if (user?.username) {
        document.getElementById('adminUsername').textContent = user.username;
        document.getElementById('adminAvatar').textContent = user.username.slice(0, 1);
      }
      initDashboard();
    } else {
      loginScreen.hidden = false;
      dashScreen.hidden = true;
    }
  } catch (err) {
    loginScreen.hidden = false;
    dashScreen.hidden = true;
    showToast('Could not verify your session. Please try logging in again.', 'error');
  }
}

const loginForm = document.getElementById('loginForm');
const loginSubmitBtn = loginForm.querySelector('button[type="submit"]');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  errorEl.hidden = true;
  setButtonLoading(loginSubmitBtn, true, 'Signing in…');

  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    showToast('Signed in successfully.', 'success');
    checkSession();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    setButtonLoading(loginSubmitBtn, false);
  }
});

const logoutBtn = document.getElementById('logoutBtn');
logoutBtn.addEventListener('click', async () => {
  setButtonLoading(logoutBtn, true, 'Logging out…');
  try {
    await api('/api/auth/logout', { method: 'POST' });
    showToast('Logged out.', 'info', 2000);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setButtonLoading(logoutBtn, false);
    checkSession();
  }
});

checkSession();

// =========================================================
// Sidebar (mobile drawer)
// =========================================================
const dashSidebar = document.getElementById('dashSidebar');
const dashOverlay = document.getElementById('dashOverlay');
const dashMobileToggle = document.getElementById('dashMobileToggle');
const dashSidebarClose = document.getElementById('dashSidebarClose');

function openSidebar() {
  dashSidebar.classList.add('is-open');
  dashOverlay.classList.add('is-visible');
  dashMobileToggle.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}
function closeSidebar() {
  dashSidebar.classList.remove('is-open');
  dashOverlay.classList.remove('is-visible');
  dashMobileToggle.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}
dashMobileToggle?.addEventListener('click', openSidebar);
dashSidebarClose?.addEventListener('click', closeSidebar);
dashOverlay?.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dashSidebar.classList.contains('is-open')) closeSidebar();
});

// =========================================================
// Dashboard nav
// =========================================================
const VIEW_TITLES = {
  overview: 'Overview', projects: 'Projects', blog: 'Blog posts', reviews: 'Client reviews',
  messages: 'Contact messages', services: 'Services', company: 'Company settings'
};
let dashInitialized = false;

function initDashboard() {
  if (dashInitialized) { loadOverview(); return; }
  dashInitialized = true;
  document.querySelectorAll('.dash__navBtn').forEach(btn => {
    btn.addEventListener('click', () => { switchView(btn.dataset.view); closeSidebar(); });
  });
  loadOverview();
  loadProjects();
  loadBlog();
  loadReviews();
  loadServices();
  loadCompany();
  loadMessages();
}

function switchView(view) {
  document.querySelectorAll('.dash__navBtn').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  document.querySelectorAll('.dash__view').forEach(v => v.hidden = v.id !== `view-${view}`);
  document.getElementById('topbarTitle').textContent = VIEW_TITLES[view] || view;
  document.getElementById('dashScreen').querySelector('.dash__main').scrollTop = 0;
  window.scrollTo(0, 0);
}

// =========================================================
// Overview
// =========================================================
const STAT_ICONS = {
  totalProjects: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4.5" width="18" height="13" rx="2"></rect><path d="M8 21h8M12 17.5V21"></path></svg>',
  publishedProjects: ICONS.eye,
  totalPosts: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3.5h9l4.5 4.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"></path><path d="M8.5 12h7M8.5 15.5h7"></path></svg>',
  publishedPosts: ICONS.eye,
  totalReviews: ICONS.star2,
  publishedReviews: ICONS.eye,
  totalMessages: ICONS.inbox,
  unreadMessages: ICONS.mail
};

async function loadOverview() {
  const statGrid = document.getElementById('statGrid');
  const activityList = document.getElementById('activityList');
  statGrid.innerHTML = Array.from({ length: 8 }).map(() => `<div class="stat-card"><div class="skeleton" style="height:1.8rem;width:50%;"></div><div class="skeleton" style="height:0.85rem;width:75%;"></div></div>`).join('');
  activityList.innerHTML = `<li><span class="spinner spinner--dark"></span> Loading activity…</li>`;

  try {
    const stats = await api('/api/dashboard/stats');
    statGrid.innerHTML = [
      ['totalProjects', stats.totalProjects, 'Total projects'],
      ['publishedProjects', stats.publishedProjects, 'Published projects'],
      ['totalPosts', stats.totalPosts, 'Total blog posts'],
      ['publishedPosts', stats.publishedPosts, 'Published posts'],
      ['totalReviews', stats.totalReviews, 'Total reviews'],
      ['publishedReviews', stats.publishedReviews, 'Published reviews'],
      ['totalMessages', stats.totalMessages, 'Total messages'],
      ['unreadMessages', stats.unreadMessages, 'Unread messages']
    ].map(([key, value, label]) => statCard(key, value, label)).join('');

    activityList.innerHTML = (stats.recentActivity || [])
      .map(a => `<li><span>${escapeHtml(a.action)} — ${escapeHtml(a.details || '')}</span><span class="activity-time">${timeAgo(a.created_at)}</span></li>`)
      .join('') || '<li>No recent activity yet.</li>';

    const badge = document.getElementById('unreadBadge');
    if (stats.unreadMessages > 0) {
      badge.textContent = stats.unreadMessages;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch (err) {
    statGrid.innerHTML = `<div class="error-row">${ICONS.warning} Failed to load stats. <button class="retry-btn" onclick="loadOverview()">Retry</button></div>`;
    activityList.innerHTML = '';
  }
}

function statCard(key, value, label) {
  return `<div class="stat-card">
    <div class="stat-card__icon" aria-hidden="true">${STAT_ICONS[key] || ''}</div>
    <div class="stat-card__value">${value ?? 0}</div>
    <div class="stat-card__label">${label}</div>
  </div>`;
}

// =========================================================
// Image upload widget — used by any field with type: 'image'
// =========================================================
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

function imageUploadFieldHtml(f, value) {
  const hasImage = !!value;
  return `
    <div class="field">
      <label>${f.label}</label>
      <div class="img-upload" data-field="${f.name}" data-folder="${f.folder || 'misc'}">
        <div class="img-upload__preview" id="imgPreview_${f.name}">
          ${hasImage ? `<img src="${escapeHtml(value)}" alt="">` : ICONS.image}
        </div>
        <div class="img-upload__body">
          <div class="img-upload__actions">
            <input type="file" id="imgFile_${f.name}" accept="${ALLOWED_IMAGE_MIME.join(',')}" hidden>
            <button type="button" class="btn btn--ghost btn--small" id="imgChoose_${f.name}">${hasImage ? 'Change image' : 'Choose image'}</button>
            <button type="button" class="btn btn--ghost btn--small" id="imgRemove_${f.name}" ${hasImage ? '' : 'hidden'}>Remove</button>
          </div>
          <p class="img-upload__status" id="imgStatus_${f.name}">JPEG, PNG, WEBP or GIF — up to 5MB.</p>
        </div>
        <input type="hidden" id="f_${f.name}" value="${escapeHtml(value || '')}">
      </div>
    </div>`;
}

function wireImageUpload(f) {
  const preview = document.getElementById(`imgPreview_${f.name}`);
  const status = document.getElementById(`imgStatus_${f.name}`);
  const fileInput = document.getElementById(`imgFile_${f.name}`);
  const hiddenInput = document.getElementById(`f_${f.name}`);
  const chooseBtn = document.getElementById(`imgChoose_${f.name}`);
  const removeBtn = document.getElementById(`imgRemove_${f.name}`);
  const folder = f.folder || 'misc';

  chooseBtn.addEventListener('click', () => fileInput.click());
  removeBtn.addEventListener('click', () => {
    hiddenInput.value = '';
    preview.innerHTML = ICONS.image;
    removeBtn.hidden = true;
    chooseBtn.textContent = 'Choose image';
    status.textContent = 'JPEG, PNG, WEBP or GIF — up to 5MB.';
    status.className = 'img-upload__status';
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!ALLOWED_IMAGE_MIME.includes(file.type)) {
      status.textContent = 'Unsupported file type. Use JPEG, PNG, WEBP or GIF.';
      status.className = 'img-upload__status is-error';
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      status.textContent = 'That file is too large. Maximum size is 5MB.';
      status.className = 'img-upload__status is-error';
      return;
    }

    const localUrl = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${localUrl}" alt=""><div class="upload-progress" id="imgProgress_${f.name}"><span class="spinner"></span></div>`;
    status.textContent = 'Uploading…';
    status.className = 'img-upload__status';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('folder', folder);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        status.textContent = `Uploading… ${pct}%`;
      }
    });
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON error body */ }
      const progressEl = document.getElementById(`imgProgress_${f.name}`);
      if (progressEl) progressEl.remove();
      if (xhr.status >= 200 && xhr.status < 300 && data.url) {
        hiddenInput.value = data.url;
        preview.innerHTML = `<img src="${escapeHtml(data.url)}" alt="">`;
        removeBtn.hidden = false;
        chooseBtn.textContent = 'Change image';
        status.textContent = 'Uploaded successfully.';
        status.className = 'img-upload__status is-success';
      } else {
        preview.innerHTML = hiddenInput.value ? `<img src="${escapeHtml(hiddenInput.value)}" alt="">` : ICONS.image;
        status.textContent = data.error || 'Upload failed. Please try again.';
        status.className = 'img-upload__status is-error';
      }
    };
    xhr.onerror = () => {
      const progressEl = document.getElementById(`imgProgress_${f.name}`);
      if (progressEl) progressEl.remove();
      status.textContent = 'Upload failed. Check your connection and try again.';
      status.className = 'img-upload__status is-error';
    };
    xhr.send(formData);
  });
}

// =========================================================
// Generic modal form (create/edit)
// =========================================================
const formModal = document.getElementById('formModal');
const formModalForm = document.getElementById('formModalForm');
const formModalTitle = document.getElementById('formModalTitle');
const formModalSave = document.getElementById('formModalSave');
let formModalOpener = null;

document.getElementById('formModalClose').addEventListener('click', closeFormModal);
document.getElementById('formModalCancel').addEventListener('click', closeFormModal);
document.getElementById('formModalBackdrop').addEventListener('click', closeFormModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !formModal.hidden) closeFormModal(); });

function closeFormModal() {
  formModal.hidden = true;
  formModalForm.innerHTML = '';
  document.body.style.overflow = '';
  if (formModalOpener && typeof formModalOpener.focus === 'function') formModalOpener.focus();
  formModalOpener = null;
}

function openFormModal(title, fields, initial, onSubmit, openerEl) {
  formModalOpener = openerEl || document.activeElement;
  formModalTitle.textContent = title;
  formModalForm.innerHTML = fields.map(f => {
    const val = initial?.[f.name] ?? '';
    if (f.type === 'image') return imageUploadFieldHtml(f, val);
    if (f.type === 'checkbox') {
      return `<div class="checkbox-row"><input type="checkbox" id="f_${f.name}" ${val ? 'checked' : ''}><label for="f_${f.name}">${f.label}</label></div>`;
    }
    if (f.type === 'textarea') {
      return `<div class="field"><label for="f_${f.name}">${f.label}</label><textarea id="f_${f.name}" rows="${f.rows || 5}">${escapeHtml(val)}</textarea>${f.hint ? `<p class="field__hint">${f.hint}</p>` : ''}</div>`;
    }
    return `<div class="field"><label for="f_${f.name}">${f.label}</label><input type="${f.type === 'array' ? 'text' : (f.type || 'text')}" id="f_${f.name}" value="${escapeHtml(val)}">${f.hint ? `<p class="field__hint">${f.hint}</p>` : ''}</div>`;
  }).join('');

  fields.filter(f => f.type === 'image').forEach(wireImageUpload);

  formModalForm.onsubmit = async (e) => {
    e.preventDefault();
    const payload = {};
    fields.forEach(f => {
      const el = document.getElementById(`f_${f.name}`);
      if (f.type === 'checkbox') payload[f.name] = el.checked;
      else if (f.type === 'array') payload[f.name] = el.value.split(',').map(s => s.trim()).filter(Boolean);
      else payload[f.name] = el.value;
    });
    setButtonLoading(formModalSave, true, 'Saving…');
    try {
      await onSubmit(payload);
      showToast('Saved successfully.', 'success');
      closeFormModal();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setButtonLoading(formModalSave, false);
    }
  };
  formModal.hidden = false;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => formModalForm.querySelector('input, textarea')?.focus());
}

async function confirmAndDelete(itemLabel, deleteFn, reloadFns) {
  if (!confirm(`Delete ${itemLabel}? This cannot be undone.`)) return;
  try {
    await deleteFn();
    showToast('Deleted successfully.', 'success', 3000);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    reloadFns.forEach(fn => fn());
  }
}

function iconBtn(icon, tip, variant, attrs) {
  return `<button type="button" class="icon-btn ${variant ? `icon-btn--${variant}` : ''}" data-tip="${tip}" aria-label="${tip}" ${attrs || ''}>${icon}</button>`;
}
function rowThumb(url, alt) {
  return url
    ? `<img class="row-thumb" src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;row-thumb row-thumb--empty&quot;>${ICONS.image.replace(/"/g, '&quot;')}</div>'">`
    : `<div class="row-thumb row-thumb--empty">${ICONS.image}</div>`;
}

// =========================================================
// Projects
// =========================================================
const projectFields = [
  { name: 'title', label: 'Title' },
  { name: 'category', label: 'Category' },
  { name: 'description', label: 'Description', type: 'textarea' },
  { name: 'image_url', label: 'Project image', type: 'image', folder: 'projects' },
  { name: 'technologies', label: 'Technologies (comma-separated)', type: 'array' },
  { name: 'client_name', label: 'Client name' },
  { name: 'completion_date', label: 'Completion date', type: 'date' },
  { name: 'live_url', label: 'Live project URL' },
  { name: 'github_url', label: 'GitHub URL' },
  { name: 'featured', label: 'Featured', type: 'checkbox' },
  { name: 'published', label: 'Published', type: 'checkbox' }
];

async function loadProjects() {
  const tbody = document.querySelector('#projectsTable tbody');
  tbody.innerHTML = skeletonRows(6);
  try {
    const { projects } = await api('/api/projects/admin/all');
    tbody.innerHTML = projects.map(p => `
      <tr>
        <td class="row-title-cell" data-label="Project">
          <div class="row-title">${rowThumb(p.image_url)}<div class="row-title__text"><strong>${escapeHtml(p.title)}</strong><span>${escapeHtml(p.client_name || '')}</span></div></div>
        </td>
        <td data-label="Category">${escapeHtml(p.category || '—')}</td>
        <td data-label="Live URL">${p.live_url ? `<a href="${escapeHtml(p.live_url)}" target="_blank" rel="noopener">View</a>` : '—'}</td>
        <td data-label="Featured">${pill(p.featured)}</td>
        <td data-label="Published">${pill(p.published)}</td>
        <td class="actions" data-label="Actions">
          <div class="row-actions">
            ${iconBtn(ICONS.edit, 'Edit', null, `data-edit="${p.id}"`)}
            ${iconBtn(ICONS.trash, 'Delete', 'danger', `data-del="${p.id}"`)}
          </div>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="6">No projects yet.</td></tr>`;

    tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
      const p = projects.find(x => x.id === btn.dataset.edit);
      openFormModal('Edit project', projectFields, { ...p, technologies: (p.technologies || []).join(', ') }, async (payload) => {
        await api(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        loadProjects(); loadOverview();
      }, btn);
    }));
    tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const p = projects.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`"${p.title}"`, () => api(`/api/projects/${btn.dataset.del}`, { method: 'DELETE' }), [loadProjects, loadOverview]);
    }));
  } catch (err) {
    tbody.innerHTML = errorRowHtml(6, 'Failed to load projects.', 'loadProjects');
  }
}
document.getElementById('newProjectBtn').addEventListener('click', (e) => {
  openFormModal('New project', projectFields, { published: true }, async (payload) => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    loadProjects(); loadOverview();
  }, e.currentTarget);
});

// =========================================================
// Blog
// =========================================================
const blogFields = [
  { name: 'title', label: 'Title' },
  { name: 'slug', label: 'Slug (optional — auto-generated if blank)' },
  { name: 'excerpt', label: 'Excerpt', type: 'textarea', rows: 3, hint: 'Shown on the blog card. Aim for one or two sentences.' },
  { name: 'featured_image_url', label: 'Featured image', type: 'image', folder: 'blog' },
  { name: 'content', label: 'Content (HTML or plain text)', type: 'textarea', rows: 10, hint: 'Plain paragraphs are auto-formatted on the public site if no HTML tags are used.' },
  { name: 'author', label: 'Author' },
  { name: 'featured', label: 'Featured', type: 'checkbox' },
  { name: 'published', label: 'Published', type: 'checkbox' }
];

async function loadBlog() {
  const tbody = document.querySelector('#blogTable tbody');
  tbody.innerHTML = skeletonRows(4);
  try {
    const { posts } = await api('/api/blog/admin/all');
    tbody.innerHTML = posts.map(p => `
      <tr>
        <td class="row-title-cell" data-label="Post">
          <div class="row-title">${rowThumb(p.featured_image_url)}<div class="row-title__text"><strong>${escapeHtml(p.title)}</strong><span>/blog/${escapeHtml(p.slug)}</span></div></div>
        </td>
        <td data-label="Featured">${pill(p.featured)}</td>
        <td data-label="Published">${pill(p.published)}</td>
        <td class="actions" data-label="Actions">
          <div class="row-actions">
            ${iconBtn(ICONS.edit, 'Edit', null, `data-edit="${p.id}"`)}
            ${iconBtn(ICONS.trash, 'Delete', 'danger', `data-del="${p.id}"`)}
          </div>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="4">No blog posts yet.</td></tr>`;

    tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
      const p = posts.find(x => x.id === btn.dataset.edit);
      openFormModal('Edit post', blogFields, p, async (payload) => {
        await api(`/api/blog/${p.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        loadBlog(); loadOverview();
      }, btn);
    }));
    tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const p = posts.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`"${p.title}"`, () => api(`/api/blog/${btn.dataset.del}`, { method: 'DELETE' }), [loadBlog, loadOverview]);
    }));
  } catch (err) {
    tbody.innerHTML = errorRowHtml(4, 'Failed to load blog posts.', 'loadBlog');
  }
}
document.getElementById('newPostBtn').addEventListener('click', (e) => {
  openFormModal('New post', blogFields, { published: false, author: 'SHEREBOY TECH LTD' }, async (payload) => {
    await api('/api/blog', { method: 'POST', body: JSON.stringify(payload) });
    loadBlog(); loadOverview();
  }, e.currentTarget);
});

// =========================================================
// Reviews
// =========================================================
const reviewFields = [
  { name: 'client_name', label: 'Client name' },
  { name: 'client_position', label: 'Client position / company' },
  { name: 'review_text', label: 'Review text', type: 'textarea' },
  { name: 'client_image_url', label: 'Client photo', type: 'image', folder: 'reviews' },
  { name: 'rating', label: 'Rating (1-5)', type: 'number' },
  { name: 'featured', label: 'Featured', type: 'checkbox' },
  { name: 'published', label: 'Published', type: 'checkbox' }
];

async function loadReviews() {
  const tbody = document.querySelector('#reviewsTable tbody');
  tbody.innerHTML = skeletonRows(5);
  try {
    const { reviews } = await api('/api/reviews/admin/all');
    tbody.innerHTML = reviews.map(r => `
      <tr>
        <td class="row-title-cell" data-label="Client">
          <div class="row-title">${rowThumb(r.client_image_url)}<div class="row-title__text"><strong>${escapeHtml(r.client_name)}</strong><span>${escapeHtml(r.client_position || '')}</span></div></div>
        </td>
        <td data-label="Rating">${starRating(r.rating || 5)}</td>
        <td data-label="Featured">${pill(r.featured)}</td>
        <td data-label="Published">${pill(r.published)}</td>
        <td class="actions" data-label="Actions">
          <div class="row-actions">
            ${iconBtn(ICONS.edit, 'Edit', null, `data-edit="${r.id}"`)}
            ${iconBtn(ICONS.trash, 'Delete', 'danger', `data-del="${r.id}"`)}
          </div>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5">No reviews yet.</td></tr>`;

    tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
      const r = reviews.find(x => x.id === btn.dataset.edit);
      openFormModal('Edit review', reviewFields, r, async (payload) => {
        await api(`/api/reviews/${r.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        loadReviews(); loadOverview();
      }, btn);
    }));
    tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const r = reviews.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`review from "${r.client_name}"`, () => api(`/api/reviews/${btn.dataset.del}`, { method: 'DELETE' }), [loadReviews, loadOverview]);
    }));
  } catch (err) {
    tbody.innerHTML = errorRowHtml(5, 'Failed to load reviews.', 'loadReviews');
  }
}
document.getElementById('newReviewBtn').addEventListener('click', (e) => {
  openFormModal('New review', reviewFields, { rating: 5, published: false }, async (payload) => {
    await api('/api/reviews', { method: 'POST', body: JSON.stringify(payload) });
    loadReviews(); loadOverview();
  }, e.currentTarget);
});

// =========================================================
// Services
// =========================================================
const serviceFields = [
  { name: 'title', label: 'Title' },
  { name: 'description', label: 'Description', type: 'textarea' },
  { name: 'icon', label: 'Icon keyword', hint: 'e.g. "web", "mobile", "cloud", "security" — used to pick a matching icon on the public site.' },
  { name: 'display_order', label: 'Display order', type: 'number' },
  { name: 'published', label: 'Published', type: 'checkbox' }
];

async function loadServices() {
  const tbody = document.querySelector('#servicesTable tbody');
  tbody.innerHTML = skeletonRows(4);
  try {
    const { services } = await api('/api/services/admin/all');
    tbody.innerHTML = services.map(s => `
      <tr>
        <td data-label="Title"><strong>${escapeHtml(s.title)}</strong></td>
        <td data-label="Order">${s.display_order}</td>
        <td data-label="Published">${pill(s.published)}</td>
        <td class="actions" data-label="Actions">
          <div class="row-actions">
            ${iconBtn(ICONS.edit, 'Edit', null, `data-edit="${s.id}"`)}
            ${iconBtn(ICONS.trash, 'Delete', 'danger', `data-del="${s.id}"`)}
          </div>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="4">No services yet.</td></tr>`;

    tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
      const s = services.find(x => x.id === btn.dataset.edit);
      openFormModal('Edit service', serviceFields, s, async (payload) => {
        await api(`/api/services/${s.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        loadServices(); loadOverview();
      }, btn);
    }));
    tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const s = services.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`"${s.title}"`, () => api(`/api/services/${btn.dataset.del}`, { method: 'DELETE' }), [loadServices, loadOverview]);
    }));
  } catch (err) {
    tbody.innerHTML = errorRowHtml(4, 'Failed to load services.', 'loadServices');
  }
}
document.getElementById('newServiceBtn').addEventListener('click', (e) => {
  openFormModal('New service', serviceFields, { published: true, display_order: 0 }, async (payload) => {
    await api('/api/services', { method: 'POST', body: JSON.stringify(payload) });
    loadServices(); loadOverview();
  }, e.currentTarget);
});

// =========================================================
// Messages — inbox with a detail panel
// =========================================================
let messagesCache = [];
const messageModal = document.getElementById('messageModal');
const messageModalBody = document.getElementById('messageModalBody');
let messageModalOpener = null;

document.getElementById('messageModalClose').addEventListener('click', closeMessageModal);
document.getElementById('messageModalBackdrop').addEventListener('click', closeMessageModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !messageModal.hidden) closeMessageModal(); });
function closeMessageModal() {
  messageModal.hidden = true;
  document.body.style.overflow = '';
  if (messageModalOpener && typeof messageModalOpener.focus === 'function') messageModalOpener.focus();
  messageModalOpener = null;
}

async function loadMessages() {
  const inbox = document.getElementById('messagesInbox');
  inbox.innerHTML = `<div class="loading-row"><span class="spinner spinner--dark"></span> Loading messages…</div>`;
  try {
    const { messages } = await api('/api/contact/admin/all');
    messagesCache = messages;
    if (!messages.length) {
      inbox.innerHTML = `<div class="inbox-empty">${ICONS.inbox}<p>No messages yet.</p></div>`;
      return;
    }
    inbox.innerHTML = messages.map(m => `
      <div class="inbox__item ${m.read ? '' : 'is-unread'}" data-open="${m.id}" tabindex="0" role="button" aria-label="Open message from ${escapeHtml(m.name)}">
        <span class="inbox__dot" aria-hidden="true"></span>
        <div class="inbox__main">
          <div class="inbox__topRow">
            <span class="inbox__from">${escapeHtml(m.name)}</span>
            <span class="inbox__time">${timeAgo(m.created_at)}</span>
          </div>
          <p class="inbox__subject">${escapeHtml(m.subject || '(No subject)')}</p>
          <p class="inbox__preview">${escapeHtml(m.message)}</p>
        </div>
        <div class="inbox__actions">
          ${iconBtn(ICONS.trash, 'Delete', 'danger', `data-del="${m.id}"`)}
        </div>
      </div>
    `).join('');

    inbox.querySelectorAll('[data-open]').forEach(el => {
      const open = () => openMessage(el.dataset.open, el);
      el.addEventListener('click', (e) => { if (!e.target.closest('[data-del]')) open(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
    inbox.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = messages.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`message from "${m.name}"`, () => api(`/api/contact/${btn.dataset.del}`, { method: 'DELETE' }), [loadMessages, loadOverview]);
    }));
  } catch (err) {
    inbox.innerHTML = `<div class="error-row">${ICONS.warning} Failed to load messages. <button class="retry-btn" onclick="loadMessages()">Retry</button></div>`;
  }
}

async function openMessage(id, openerEl) {
  const m = messagesCache.find(x => x.id === id);
  if (!m) return;
  messageModalOpener = openerEl;
  messageModalBody.innerHTML = `
    <dl class="message-detail__meta">
      <dt>From</dt><dd>${escapeHtml(m.name)}</dd>
      <dt>Email</dt><dd><a href="mailto:${escapeHtml(m.email)}">${escapeHtml(m.email)}</a></dd>
      ${m.phone ? `<dt>Phone</dt><dd><a href="tel:${escapeHtml(m.phone)}">${escapeHtml(m.phone)}</a></dd>` : ''}
      <dt>Subject</dt><dd>${escapeHtml(m.subject || '(No subject)')}</dd>
      <dt>Received</dt><dd>${new Date(m.created_at).toLocaleString()}</dd>
      <dt>Status</dt><dd id="msgStatusPill">${pill(m.read)}</dd>
    </dl>
    <div class="message-detail__body">${escapeHtml(m.message)}</div>
    <div class="message-detail__actions">
      <button type="button" class="btn btn--ghost btn--small" id="msgToggleRead">${m.read ? 'Mark as unread' : 'Mark as read'}</button>
      <button type="button" class="btn btn--danger btn--small" id="msgDelete">${ICONS.trash} Delete</button>
    </div>
  `;
  messageModal.hidden = false;
  document.body.style.overflow = 'hidden';

  document.getElementById('msgToggleRead').addEventListener('click', async (e) => {
    setButtonLoading(e.currentTarget, true, 'Saving…');
    try {
      await api(`/api/contact/${m.id}/read`, { method: 'PUT', body: JSON.stringify({ read: !m.read }) });
      closeMessageModal();
      loadMessages(); loadOverview();
    } catch (err) {
      showToast(err.message, 'error');
      setButtonLoading(e.currentTarget, false);
    }
  });
  document.getElementById('msgDelete').addEventListener('click', () => {
    closeMessageModal();
    confirmAndDelete(`message from "${m.name}"`, () => api(`/api/contact/${m.id}`, { method: 'DELETE' }), [loadMessages, loadOverview]);
  });

  if (!m.read) {
    try {
      await api(`/api/contact/${m.id}/read`, { method: 'PUT', body: JSON.stringify({ read: true }) });
      m.read = true;
      loadOverview();
      const badge = document.querySelector(`[data-open="${id}"]`);
      badge?.classList.remove('is-unread');
      const toggleBtn = document.getElementById('msgToggleRead');
      if (toggleBtn) toggleBtn.textContent = 'Mark as unread';
      const statusPill = document.getElementById('msgStatusPill');
      if (statusPill) statusPill.innerHTML = pill(true);
    } catch (err) { /* non-critical — read state will sync on next load */ }
  }
}

// =========================================================
// Company settings — grouped cards
// =========================================================
const COMPANY_SECTIONS = [
  {
    title: 'Company information',
    fields: [
      { name: 'company_name', label: 'Company name' },
      { name: 'cac_number', label: 'CAC registration number' },
      { name: 'address', label: 'Address / location' },
      { name: 'description', label: 'Company description', type: 'textarea', full: true }
    ]
  },
  {
    title: 'Leadership',
    fields: [
      { name: 'ceo_photo_url', label: 'CEO photo', type: 'image', folder: 'company', full: true },
      { name: 'ceo_name', label: 'CEO name' },
      { name: 'ceo_title', label: 'CEO title' },
      { name: 'ceo_bio', label: 'CEO bio', type: 'textarea', full: true }
    ]
  },
  {
    title: 'Mission & vision',
    fields: [
      { name: 'mission', label: 'Mission', type: 'textarea', full: true },
      { name: 'vision', label: 'Vision', type: 'textarea', full: true }
    ]
  },
  {
    title: 'Contact information',
    fields: [
      { name: 'email', label: 'Email' },
      { name: 'phone', label: 'Phone number' },
      { name: 'whatsapp', label: 'WhatsApp number' },
      { name: 'cac_document_url', label: 'CAC document URL' }
    ]
  },
  {
    title: 'Social media',
    fields: [
      { name: 'instagram_url', label: 'Instagram URL' },
      { name: 'tiktok_url', label: 'TikTok URL' },
      { name: 'youtube_url', label: 'YouTube URL' }
    ]
  },
  {
    title: 'Brand assets',
    fields: [
      { name: 'logo_url', label: 'Company logo', type: 'image', folder: 'company', full: true }
    ]
  }
];
const companyFields = COMPANY_SECTIONS.flatMap(s => s.fields);

async function loadCompany() {
  const wrap = document.getElementById('companySettings');
  wrap.innerHTML = `<div class="loading-row"><span class="spinner spinner--dark"></span> Loading company settings…</div>`;
  try {
    const { company } = await api('/api/company');

    wrap.innerHTML = `<form id="companyForm">` +
      COMPANY_SECTIONS.map(section => `
        <div class="settings-card">
          <h3>${section.title}</h3>
          <div class="settings-card__grid">
            ${section.fields.map(f => {
              const val = company[f.name] || '';
              if (f.type === 'image') return `<div class="${f.full ? 'full' : ''}">${imageUploadFieldHtml(f, val)}</div>`;
              if (f.type === 'textarea') return `<div class="field ${f.full ? 'full' : ''}"><label for="cf_${f.name}">${f.label}</label><textarea id="cf_${f.name}" rows="4">${escapeHtml(val)}</textarea></div>`;
              return `<div class="field ${f.full ? 'full' : ''}"><label for="cf_${f.name}">${f.label}</label><input type="text" id="cf_${f.name}" value="${escapeHtml(val)}"></div>`;
            }).join('')}
          </div>
        </div>
      `).join('') +
      `<div class="settings-actions"><button type="submit" class="btn btn--primary" id="companySaveBtn">Save all changes</button></div>` +
      `</form>`;

    // Image fields inside company settings use ids prefixed with cf_ instead of f_ —
    // remap the upload widget's target ids to match this form's naming.
    companyFields.filter(f => f.type === 'image').forEach(f => {
      const originalName = f.name;
      wireImageUpload({ ...f, name: originalName });
      // wireImageUpload wrote to #f_<name>; alias it into #cf_<name> for the submit handler below.
    });

    const saveBtn = document.getElementById('companySaveBtn');
    const form = document.getElementById('companyForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {};
      companyFields.forEach(f => {
        const el = f.type === 'image' ? document.getElementById(`f_${f.name}`) : document.getElementById(`cf_${f.name}`);
        if (el) payload[f.name] = el.value;
      });
      setButtonLoading(saveBtn, true, 'Saving…');
      try {
        await api('/api/company', { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Company settings saved.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        setButtonLoading(saveBtn, false);
      }
    });
  } catch (err) {
    wrap.innerHTML = `<div class="error-row">${ICONS.warning} Failed to load company settings. <button class="retry-btn" onclick="loadCompany()">Retry</button></div>`;
  }
}
