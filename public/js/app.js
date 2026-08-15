// public/js/app.js
// Vanilla JS frontend logic — fetches public data from the REST API and
// renders it into the page, with loading / success / error feedback at
// every step so the site never feels static. No secrets ever live here.

document.getElementById('year').textContent = new Date().getFullYear();

// =========================================================
// Toast notifications — shared success/error/info feedback
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
// Button loading-state helper — disables button, shows spinner
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

// =========================================================
// Helpers
// =========================================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function loadingRow(text, onDark = true) {
  return `<div class="loading-row"><span class="spinner ${onDark ? '' : 'spinner--dark'}"></span> ${escapeHtml(text)}</div>`;
}

function errorRow(text, retryFnName) {
  return `<div class="error-row">⚠ ${escapeHtml(text)} <button class="retry-btn" onclick="${retryFnName}()">Retry</button></div>`;
}

function skeletonCards(count, className) {
  return Array.from({ length: count }).map(() => `<div class="skeleton skeleton-card ${className || ''}"></div>`).join('');
}

async function apiGet(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

// ---------- Mobile nav ----------
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
navToggle?.addEventListener('click', () => {
  const isOpen = navLinks.classList.toggle('is-open');
  navToggle.setAttribute('aria-expanded', String(isOpen));
});
navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => navLinks.classList.remove('is-open')));

// =========================================================
// Company info
// =========================================================
async function loadCompanyInfo() {
  try {
    const { company } = await apiGet('/api/company');
    if (!company) return;
    document.getElementById('aboutDescription').textContent = company.description || 'Company description coming soon.';
    document.getElementById('aboutMission').textContent = company.mission || '[COMPANY MISSION]';
    document.getElementById('aboutVision').textContent = company.vision || '[COMPANY VISION]';
    document.getElementById('aboutCac').textContent = company.cac_number || '[INSERT CAC NUMBER HERE]';
    document.getElementById('ceoName').textContent = company.ceo_name || 'BAWO MADAMEDON';
    document.getElementById('ceoTitle').textContent = company.ceo_title || 'CEO, SHEREBOY TECH LTD';
    document.getElementById('ceoBio').textContent = company.ceo_bio || '[CEO BIO]';
    if (company.ceo_photo_url) {
      document.getElementById('ceoPhoto').innerHTML = `<img src="${escapeHtml(company.ceo_photo_url)}" alt="${escapeHtml(company.ceo_name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    }
    if (company.email) document.getElementById('contactEmail').href = `mailto:${company.email}`;
    if (company.whatsapp) document.getElementById('contactWhatsapp').href = `https://wa.me/${company.whatsapp.replace(/\D/g, '')}`;
    if (company.phone) document.getElementById('contactCall').href = `tel:${company.phone}`;
    if (company.instagram_url) document.getElementById('socialInstagram').href = company.instagram_url;
    if (company.tiktok_url) document.getElementById('socialTiktok').href = company.tiktok_url;
    if (company.youtube_url) document.getElementById('socialYoutube').href = company.youtube_url;

    if (company.logo_url) {
      const navLogo = document.getElementById('navLogo');
      const footerLogo = document.getElementById('footerLogo');
      navLogo.onerror = () => { navLogo.hidden = true; };
      navLogo.onload = () => { navLogo.hidden = false; };
      navLogo.src = company.logo_url;
      footerLogo.src = company.logo_url;
      footerLogo.onload = () => { footerLogo.hidden = false; };
    }
  } catch (err) {
    // Non-critical section — fail quietly, defaults already shown in markup
    console.error('Failed to load company info:', err.message);
  }
}
loadCompanyInfo();

// =========================================================
// Services
// =========================================================
async function loadServices() {
  const grid = document.getElementById('servicesGrid');
  grid.innerHTML = skeletonCards(3);
  try {
    const { services } = await apiGet('/api/services');
    if (!services || !services.length) { grid.innerHTML = '<p class="empty-state">Services will be listed here soon.</p>'; return; }
    grid.innerHTML = services.map(s => `
      <div class="card">
        <h3>${escapeHtml(s.title)}</h3>
        <p>${escapeHtml(s.description || '')}</p>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = errorRow('Unable to load services right now.', 'loadServices');
  }
}
loadServices();

// =========================================================
// Projects
// =========================================================
async function loadProjects() {
  const grid = document.getElementById('projectsGrid');
  grid.innerHTML = skeletonCards(3);
  try {
    const { projects } = await apiGet('/api/projects?featured=true&limit=6');
    const list = projects || [];
    if (!list.length) { grid.innerHTML = '<p class="empty-state empty-state--onDark">Projects will be showcased here soon.</p>'; return; }
    grid.innerHTML = list.map(p => `
      <div class="project-card">
        ${p.image_url ? `<img class="project-card__img" src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.title)}" loading="lazy">` : `<div class="project-card__img"></div>`}
        <div class="project-card__body">
          <p class="project-card__cat">${escapeHtml(p.category || 'Web Project')}</p>
          <h3>${escapeHtml(p.title)}</h3>
          <p>${escapeHtml(p.description || '')}</p>
          <div class="project-card__tech">${(p.technologies || []).map(t => `<span class="tech-chip">${escapeHtml(t)}</span>`).join('')}</div>
          ${p.live_url ? `<a class="project-card__link" href="${escapeHtml(p.live_url)}" target="_blank" rel="noopener">View Live Project →</a>` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = errorRow('Unable to load projects right now.', 'loadProjects');
  }
}
loadProjects();

// =========================================================
// Reviews
// =========================================================
async function loadReviews() {
  const grid = document.getElementById('reviewsGrid');
  grid.innerHTML = skeletonCards(3);
  try {
    const { reviews } = await apiGet('/api/reviews');
    if (!reviews || !reviews.length) { grid.innerHTML = '<p class="empty-state">Client reviews will appear here soon.</p>'; return; }
    grid.innerHTML = reviews.map(r => `
      <div class="card review-card">
        <div class="review-card__stars">${'★'.repeat(r.rating || 5)}${'☆'.repeat(5 - (r.rating || 5))}</div>
        <p>"${escapeHtml(r.review_text)}"</p>
        <p class="review-card__name">${escapeHtml(r.client_name)}</p>
        <p class="review-card__pos">${escapeHtml(r.client_position || '')}</p>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = errorRow('Unable to load reviews right now.', 'loadReviews');
  }
}
loadReviews();

// =========================================================
// Blog
// =========================================================
async function loadBlog() {
  const grid = document.getElementById('blogGrid');
  grid.innerHTML = skeletonCards(3);
  try {
    const { posts } = await apiGet('/api/blog?limit=3');
    if (!posts || !posts.length) { grid.innerHTML = '<p class="empty-state">Blog posts will appear here soon.</p>'; return; }
    grid.innerHTML = posts.map(p => `
      <div class="card">
        ${p.featured_image_url ? `<img class="blog-card__img" src="${escapeHtml(p.featured_image_url)}" alt="${escapeHtml(p.title)}" loading="lazy">` : ''}
        <p class="blog-card__meta">${new Date(p.created_at).toLocaleDateString()} · ${escapeHtml(p.author || 'SHEREBOY TECH LTD')}</p>
        <h3>${escapeHtml(p.title)}</h3>
        <p>${escapeHtml(p.excerpt || '')}</p>
        <a class="blog-card__link" href="/blog/${escapeHtml(p.slug)}" data-slug="${escapeHtml(p.slug)}">Read post →</a>
      </div>
    `).join('');
    grid.querySelectorAll('[data-slug]').forEach(a => {
      a.addEventListener('click', (e) => { e.preventDefault(); openPost(a.dataset.slug); });
    });
  } catch (err) {
    grid.innerHTML = errorRow('Unable to load blog posts right now.', 'loadBlog');
  }
}
loadBlog();

// =========================================================
// Blog post modal
// =========================================================
const postModal = document.getElementById('postModal');
async function openPost(slug) {
  document.getElementById('postModalContent').innerHTML = loadingRow('Loading post…', false);
  postModal.hidden = false;
  try {
    const { post } = await apiGet(`/api/blog/${encodeURIComponent(slug)}`);
    document.getElementById('postModalContent').innerHTML = `
      ${post.featured_image_url ? `<img src="${escapeHtml(post.featured_image_url)}" alt="${escapeHtml(post.title)}">` : ''}
      <h2>${escapeHtml(post.title)}</h2>
      <p class="post-meta">${new Date(post.created_at).toLocaleDateString()} · ${escapeHtml(post.author || 'SHEREBOY TECH LTD')}</p>
      <div>${post.content}</div>
    `;
    history.pushState({}, '', `/blog/${slug}`);
  } catch (err) {
    document.getElementById('postModalContent').innerHTML = `<p>Sorry, that post could not be loaded. ${escapeHtml(err.message)}</p>`;
    showToast('Could not load that post.', 'error');
  }
}
document.getElementById('postModalClose')?.addEventListener('click', closePost);
document.getElementById('postModalBackdrop')?.addEventListener('click', closePost);
function closePost() {
  postModal.hidden = true;
  history.pushState({}, '', '/');
}

// Deep-link support: if the page loads on /blog/:slug, open it directly
const blogMatch = window.location.pathname.match(/^\/blog\/([a-z0-9-]+)$/i);
if (blogMatch) openPost(blogMatch[1]);

// =========================================================
// AI Chat
// =========================================================
const aiChatForm = document.getElementById('aiChatForm');
const aiChatInput = document.getElementById('aiChatInput');
const aiChatLog = document.getElementById('aiChatLog');
const aiChatSendBtn = aiChatForm?.querySelector('button[type="submit"]');
const chatHistory = [];

function appendMsg(text, cls) {
  const div = document.createElement('div');
  div.className = `ai-msg ${cls}`;
  div.textContent = text;
  aiChatLog.appendChild(div);
  aiChatLog.scrollTop = aiChatLog.scrollHeight;
  return div;
}

function appendTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'ai-msg ai-msg--bot ai-msg--typing';
  div.innerHTML = `<span class="spinner"></span> Thinking…`;
  aiChatLog.appendChild(div);
  aiChatLog.scrollTop = aiChatLog.scrollHeight;
  return div;
}

aiChatForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = aiChatInput.value.trim();
  if (!message) return;
  appendMsg(message, 'ai-msg--user');
  chatHistory.push({ role: 'user', text: message });
  aiChatInput.value = '';
  aiChatInput.disabled = true;
  setButtonLoading(aiChatSendBtn, true, 'Sending');
  const typingEl = appendTypingIndicator();

  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: chatHistory })
    });
    const data = await res.json();
    typingEl.remove();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    appendMsg(data.reply, 'ai-msg--bot');
    chatHistory.push({ role: 'assistant', text: data.reply });
  } catch (err) {
    typingEl.remove();
    appendMsg(err.message || 'The assistant is unavailable right now.', 'ai-msg--error');
  } finally {
    aiChatInput.disabled = false;
    setButtonLoading(aiChatSendBtn, false);
    aiChatInput.focus();
  }
});

// =========================================================
// Contact form
// =========================================================
const contactForm = document.getElementById('contactForm');
const contactStatus = document.getElementById('contactFormStatus');
const contactSubmitBtn = document.getElementById('contactSubmitBtn');

contactForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  contactStatus.hidden = true;
  setButtonLoading(contactSubmitBtn, true, 'Sending…');

  const payload = {
    name: document.getElementById('cfName').value.trim(),
    email: document.getElementById('cfEmail').value.trim(),
    phone: document.getElementById('cfPhone').value.trim(),
    subject: document.getElementById('cfSubject').value.trim(),
    message: document.getElementById('cfMessage').value.trim()
  };

  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

    const successMsg = data.message || "Thanks — we'll get back to you soon.";
    contactStatus.textContent = successMsg;
    contactStatus.className = 'contact-form__status contact-form__status--success';
    contactStatus.hidden = false;
    contactForm.reset();
    showToast(successMsg, 'success');
  } catch (err) {
    contactStatus.textContent = err.message;
    contactStatus.className = 'contact-form__status contact-form__status--error';
    contactStatus.hidden = false;
    showToast(err.message, 'error');
  } finally {
    setButtonLoading(contactSubmitBtn, false);
  }
});