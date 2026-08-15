// public/admin/admin.js
// Admin dashboard logic. Every write operation is also re-validated
// server-side — this file only handles UI + API calls, with clear
// loading / success / error feedback at every step.

const loginScreen = document.getElementById('loginScreen');
const dashScreen = document.getElementById('dashScreen');

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
    btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.innerHTML = `<span class="spinner"></span> ${loadingText}`;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.textContent = btn.dataset.originalText || btn.textContent;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function pill(bool) { return `<span class="pill ${bool ? 'pill--yes' : 'pill--no'}">${bool ? 'Yes' : 'No'}</span>`; }

function skeletonRows(cols, count = 4) {
  return Array.from({ length: count }).map(() => `
    <tr class="skeleton-row">${Array.from({ length: cols }).map(() => `<td><div class="skeleton" style="width:${60 + Math.random() * 30}%"></div></td>`).join('')}</tr>
  `).join('');
}

function errorRowHtml(cols, message, retryFnName) {
  return `<tr><td colspan="${cols}"><div class="error-row">⚠ ${escapeHtml(message)} <button class="retry-btn" onclick="${retryFnName}()">Retry</button></div></td></tr>`;
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
    const { authenticated } = await api('/api/auth/session');
    if (authenticated) {
      loginScreen.hidden = true;
      dashScreen.hidden = false;
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
// Dashboard nav
// =========================================================
function initDashboard() {
  document.querySelectorAll('.dash__navBtn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
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
}

// =========================================================
// Overview
// =========================================================
async function loadOverview() {
  const statGrid = document.getElementById('statGrid');
  const activityList = document.getElementById('activityList');
  statGrid.innerHTML = Array.from({ length: 6 }).map(() => `<div class="stat-card"><div class="skeleton" style="height:2rem;width:60%;margin-bottom:0.5rem;"></div><div class="skeleton" style="height:0.9rem;width:80%;"></div></div>`).join('');
  activityList.innerHTML = `<li><span class="spinner spinner--dark"></span> Loading activity…</li>`;

  try {
    const stats = await api('/api/dashboard/stats');
    statGrid.innerHTML = `
      ${statCard(stats.totalProjects, 'Total projects')}
      ${statCard(stats.publishedProjects, 'Published projects')}
      ${statCard(stats.totalPosts, 'Total blog posts')}
      ${statCard(stats.publishedPosts, 'Published posts')}
      ${statCard(stats.totalReviews, 'Total reviews')}
      ${statCard(stats.publishedReviews, 'Published reviews')}
      ${statCard(stats.totalMessages, 'Total messages')}
      ${statCard(stats.unreadMessages, 'Unread messages')}
    `;
    activityList.innerHTML = (stats.recentActivity || [])
      .map(a => `<li>${escapeHtml(a.action)} — ${escapeHtml(a.details || '')} <span style="float:right">${new Date(a.created_at).toLocaleString()}</span></li>`)
      .join('') || '<li>No recent activity.</li>';

    const badge = document.getElementById('unreadBadge');
    if (stats.unreadMessages > 0) {
      badge.textContent = stats.unreadMessages;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch (err) {
    statGrid.innerHTML = `<div class="error-row">⚠ Failed to load stats. <button class="retry-btn" onclick="loadOverview()">Retry</button></div>`;
    activityList.innerHTML = '';
  }
}

function statCard(value, label) {
  return `<div class="stat-card"><div class="stat-card__value">${value ?? 0}</div><div class="stat-card__label">${label}</div></div>`;
}

// =========================================================
// Generic modal form (create/edit)
// =========================================================
const formModal = document.getElementById('formModal');
const formModalForm = document.getElementById('formModalForm');
const formModalTitle = document.getElementById('formModalTitle');
document.getElementById('formModalClose').addEventListener('click', closeFormModal);
document.getElementById('formModalBackdrop').addEventListener('click', closeFormModal);
function closeFormModal() { formModal.hidden = true; formModalForm.innerHTML = ''; }

function openFormModal(title, fields, initial, onSubmit) {
  formModalTitle.textContent = title;
  formModalForm.innerHTML = fields.map(f => {
    const val = initial?.[f.name] ?? '';
    if (f.type === 'checkbox') {
      return `<div class="checkbox-row"><input type="checkbox" id="f_${f.name}" ${val ? 'checked' : ''}><label for="f_${f.name}">${f.label}</label></div>`;
    }
    if (f.type === 'textarea') {
      return `<label>${f.label}</label><textarea id="f_${f.name}" rows="5">${escapeHtml(val)}</textarea>`;
    }
    return `<label>${f.label}</label><input type="${f.type || 'text'}" id="f_${f.name}" value="${escapeHtml(val)}">`;
  }).join('') + `<button type="submit" class="btn btn--primary">Save</button>`;

  const saveBtn = formModalForm.querySelector('button[type="submit"]');

  formModalForm.onsubmit = async (e) => {
    e.preventDefault();
    const payload = {};
    fields.forEach(f => {
      const el = document.getElementById(`f_${f.name}`);
      if (f.type === 'checkbox') payload[f.name] = el.checked;
      else if (f.type === 'array') payload[f.name] = el.value.split(',').map(s => s.trim()).filter(Boolean);
      else payload[f.name] = el.value;
    });
    setButtonLoading(saveBtn, true, 'Saving…');
    try {
      await onSubmit(payload);
      showToast('Saved successfully.', 'success');
      closeFormModal();
    } catch (err) {
      showToast(err.message, 'error');
      setButtonLoading(saveBtn, false);
    }
  };
  formModal.hidden = false;
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

// =========================================================
// Projects
// =========================================================
const projectFields = [
  { name: 'title', label: 'Title' },
  { name: 'category', label: 'Category' },
  { name: 'description', label: 'Description', type: 'textarea' },
  { name: 'image_url', label: 'Image URL' },
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
        <td>${escapeHtml(p.title)}</td>
        <td>${escapeHtml(p.category || '')}</td>
        <td>${p.live_url ? `<a href="${escapeHtml(p.live_url)}" target="_blank">Link</a>` : '—'}</td>
        <td>${pill(p.featured)}</td>
        <td>${pill(p.published)}</td>
        <td class="actions">
          <button class="btn btn--ghost btn--small" data-edit="${p.id}">Edit</button>
          <button class="btn btn--danger btn--small" data-del="${p.id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="6">No projects yet.</td></tr>`;

    tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
      const p = projects.find(x => x.id === btn.dataset.edit);
      openFormModal('Edit project', projectFields, { ...p, technologies: (p.technologies || []).join(', ') }, async (payload) => {
        await api(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        loadProjects(); loadOverview();
      });
    }));
    tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const p = projects.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`"${p.title}"`, () => api(`/api/projects/${btn.dataset.del}`, { method: 'DELETE' }), [loadProjects, loadOverview]);
    }));
  } catch (err) {
    tbody.innerHTML = errorRowHtml(6, 'Failed to load projects.', 'loadProjects');
  }
}
document.getElementById('newProjectBtn').addEventListener('click', () => {
  openFormModal('New project', projectFields, { published: true }, async (payload) => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    loadProjects(); loadOverview();
  });
});

// =========================================================
// Blog
// =========================================================
const blogFields = [
  { name: 'title', label: 'Title' },
  { name: 'slug', label: 'Slug (optional — auto-generated if blank)' },
  { name: 'excerpt', label: 'Excerpt', type: 'textarea' },
  { name: 'content', label: 'Content (HTML)', type: 'textarea' },
  { name: 'featured_image_url', label: 'Featured image URL' },
  { name: 'author', label: 'Author' },
  { name: 'featured', label: 'Featured', type: 'checkbox' },
  { name: 'published', label: 'Published', type: 'checkbox' }
];

async function loadBlog() {
  const tbody = document.querySelector('#blogTable tbody');
  tbody.innerHTML = skeletonRows(5);
  try {
    const { posts } = await api('/api/blog/admin/all');
    tbody.innerHTML = posts.map(p => `
      <tr>
        <td>${escapeHtml(p.title)}</td>
        <td>${escapeHtml(p.category_id || '—')}</td>
        <td>${pill(p.featured)}</td>
        <td>${pill(p.published)}</td>
        <td class="actions">
          <button class="btn btn--ghost btn--small" data-edit="${p.id}">Edit</button>
          <button class="btn btn--danger btn--small" data-del="${p.id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5">No blog posts yet.</td></tr>`;

    tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
      const p = posts.find(x => x.id === btn.dataset.edit);
      openFormModal('Edit post', blogFields, p, async (payload) => {
        await api(`/api/blog/${p.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        loadBlog(); loadOverview();
      });
    }));
    tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const p = posts.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`"${p.title}"`, () => api(`/api/blog/${btn.dataset.del}`, { method: 'DELETE' }), [loadBlog, loadOverview]);
    }));
  } catch (err) {
    tbody.innerHTML = errorRowHtml(5, 'Failed to load blog posts.', 'loadBlog');
  }
}
document.getElementById('newPostBtn').addEventListener('click', () => {
  openFormModal('New post', blogFields, { published: false, author: 'SHEREBOY TECH LTD' }, async (payload) => {
    await api('/api/blog', { method: 'POST', body: JSON.stringify(payload) });
    loadBlog(); loadOverview();
  });
});

// =========================================================
// Reviews
// =========================================================
const reviewFields = [
  { name: 'client_name', label: 'Client name' },
  { name: 'client_position', label: 'Client position / company' },
  { name: 'review_text', label: 'Review text', type: 'textarea' },
  { name: 'client_image_url', label: 'Client photo URL' },
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
        <td>${escapeHtml(r.client_name)}</td>
        <td>${'★'.repeat(r.rating || 5)}</td>
        <td>${pill(r.featured)}</td>
        <td>${pill(r.published)}</td>
        <td class="actions">
          <button class="btn btn--ghost btn--small" data-edit="${r.id}">Edit</button>
          <button class="btn btn--danger btn--small" data-del="${r.id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5">No reviews yet.</td></tr>`;

    tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
      const r = reviews.find(x => x.id === btn.dataset.edit);
      openFormModal('Edit review', reviewFields, r, async (payload) => {
        await api(`/api/reviews/${r.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        loadReviews(); loadOverview();
      });
    }));
    tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const r = reviews.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`review from "${r.client_name}"`, () => api(`/api/reviews/${btn.dataset.del}`, { method: 'DELETE' }), [loadReviews, loadOverview]);
    }));
  } catch (err) {
    tbody.innerHTML = errorRowHtml(5, 'Failed to load reviews.', 'loadReviews');
  }
}
document.getElementById('newReviewBtn').addEventListener('click', () => {
  openFormModal('New review', reviewFields, { rating: 5, published: false }, async (payload) => {
    await api('/api/reviews', { method: 'POST', body: JSON.stringify(payload) });
    loadReviews(); loadOverview();
  });
});

// =========================================================
// Services
// =========================================================
const serviceFields = [
  { name: 'title', label: 'Title' },
  { name: 'description', label: 'Description', type: 'textarea' },
  { name: 'icon', label: 'Icon (optional label/emoji)' },
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
        <td>${escapeHtml(s.title)}</td>
        <td>${s.display_order}</td>
        <td>${pill(s.published)}</td>
        <td class="actions">
          <button class="btn btn--ghost btn--small" data-edit="${s.id}">Edit</button>
          <button class="btn btn--danger btn--small" data-del="${s.id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="4">No services yet.</td></tr>`;

    tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
      const s = services.find(x => x.id === btn.dataset.edit);
      openFormModal('Edit service', serviceFields, s, async (payload) => {
        await api(`/api/services/${s.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        loadServices(); loadOverview();
      });
    }));
    tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const s = services.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`"${s.title}"`, () => api(`/api/services/${btn.dataset.del}`, { method: 'DELETE' }), [loadServices, loadOverview]);
    }));
  } catch (err) {
    tbody.innerHTML = errorRowHtml(4, 'Failed to load services.', 'loadServices');
  }
}
document.getElementById('newServiceBtn').addEventListener('click', () => {
  openFormModal('New service', serviceFields, { published: true, display_order: 0 }, async (payload) => {
    await api('/api/services', { method: 'POST', body: JSON.stringify(payload) });
    loadServices(); loadOverview();
  });
});

// =========================================================
// Messages
// =========================================================
async function loadMessages() {
  const tbody = document.querySelector('#messagesTable tbody');
  tbody.innerHTML = skeletonRows(5);
  try {
    const { messages } = await api('/api/contact/admin/all');
    tbody.innerHTML = messages.map(m => `
      <tr>
        <td>${escapeHtml(m.name)}<br><span style="color:var(--text-mute);font-size:0.82rem">${escapeHtml(m.email)}</span></td>
        <td>${escapeHtml(m.subject || '—')}</td>
        <td>${new Date(m.created_at).toLocaleString()}</td>
        <td>${pill(m.read)}</td>
        <td class="actions">
          <button class="btn btn--ghost btn--small" data-view="${m.id}">View</button>
          <button class="btn btn--danger btn--small" data-del="${m.id}">Delete</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5">No messages yet.</td></tr>`;

    tbody.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', async () => {
      const m = messages.find(x => x.id === btn.dataset.view);
      alert(
        `From: ${m.name} <${m.email}>\n` +
        (m.phone ? `Phone: ${m.phone}\n` : '') +
        (m.subject ? `Subject: ${m.subject}\n` : '') +
        `\n${m.message}`
      );
      if (!m.read) {
        try {
          await api(`/api/contact/${m.id}/read`, { method: 'PUT', body: JSON.stringify({ read: true }) });
          loadMessages(); loadOverview();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    }));
    tbody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const m = messages.find(x => x.id === btn.dataset.del);
      confirmAndDelete(`message from "${m.name}"`, () => api(`/api/contact/${btn.dataset.del}`, { method: 'DELETE' }), [loadMessages, loadOverview]);
    }));
  } catch (err) {
    tbody.innerHTML = errorRowHtml(5, 'Failed to load messages.', 'loadMessages');
  }
}

// =========================================================
// Company settings
// =========================================================
const companyFields = [
  { name: 'company_name', label: 'Company name' },
  { name: 'ceo_name', label: 'CEO name' },
  { name: 'ceo_title', label: 'CEO title' },
  { name: 'ceo_photo_url', label: 'CEO photo URL' },
  { name: 'description', label: 'Company description', full: true },
  { name: 'mission', label: 'Mission', full: true },
  { name: 'vision', label: 'Vision', full: true },
  { name: 'ceo_bio', label: 'CEO bio', full: true },
  { name: 'address', label: 'Company address' },
  { name: 'cac_number', label: 'CAC registration number' },
  { name: 'cac_document_url', label: 'CAC document URL' },
  { name: 'logo_url', label: 'Logo URL' },
  { name: 'email', label: 'Email' },
  { name: 'whatsapp', label: 'WhatsApp number' },
  { name: 'phone', label: 'Phone number' },
  { name: 'instagram_url', label: 'Instagram URL' },
  { name: 'tiktok_url', label: 'TikTok URL' },
  { name: 'youtube_url', label: 'YouTube URL' }
];

async function loadCompany() {
  const form = document.getElementById('companyForm');
  form.innerHTML = `<div class="full loading-row"><span class="spinner spinner--dark"></span> Loading company settings…</div>`;
  try {
    const { company } = await api('/api/company');
    form.innerHTML = companyFields.map(f => `
      <div class="${f.full ? 'full' : ''}">
        <label>${f.label}</label>
        <textarea id="cf_${f.name}" rows="3">${escapeHtml(company[f.name] || '')}</textarea>
      </div>
    `).join('') + `<div class="full"><button type="submit" class="btn btn--primary">Save company settings</button></div>`;

    const saveBtn = form.querySelector('button[type="submit"]');

    form.onsubmit = async (e) => {
      e.preventDefault();
      const payload = {};
      companyFields.forEach(f => payload[f.name] = document.getElementById(`cf_${f.name}`).value);
      setButtonLoading(saveBtn, true, 'Saving…');
      try {
        await api('/api/company', { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Company settings saved.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        setButtonLoading(saveBtn, false);
      }
    };
  } catch (err) {
    form.innerHTML = `<div class="full error-row">⚠ Failed to load company settings. <button type="button" class="retry-btn" onclick="loadCompany()">Retry</button></div>`;
  }
}