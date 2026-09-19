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
// Preloader — animates the site name in, then reveals the page
// =========================================================
(function initPreloader() {
  const preloader = document.getElementById('preloader');
  if (!preloader) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.body.classList.add('is-preloading');

  const MIN_DISPLAY = prefersReducedMotion ? 150 : 1650;
  const start = Date.now();
  let hidden = false;

  function hidePreloader() {
    if (hidden) return;
    hidden = true;
    const elapsed = Date.now() - start;
    const wait = Math.max(MIN_DISPLAY - elapsed, 0);
    setTimeout(() => {
      preloader.classList.add('is-hidden');
      preloader.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('is-preloading');
      setTimeout(() => preloader.remove(), 550);
    }, wait);
  }

  if (document.readyState === 'complete') {
    hidePreloader();
  } else {
    window.addEventListener('load', hidePreloader);
  }
  // Safety net in case 'load' is delayed by a slow third-party asset
  setTimeout(hidePreloader, 4500);
})();

// =========================================================
// Scroll reveals — fade/slide elements in as they enter view
// =========================================================
const revealObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' })
  : null;

function observeReveals(root = document) {
  const els = root.querySelectorAll ? root.querySelectorAll('.reveal:not(.is-visible)') : [];
  if (!revealObserver) {
    els.forEach(el => el.classList.add('is-visible')); // graceful fallback
    return;
  }
  els.forEach(el => revealObserver.observe(el));
}
document.addEventListener('DOMContentLoaded', () => observeReveals());
// In case DOMContentLoaded already fired before this script ran
if (document.readyState !== 'loading') observeReveals();

// Safety net: a fast/instant scroll (fragment jump, scrollbar drag, "find in
// page") can skip past elements without the IntersectionObserver ever
// reporting them as intersecting. Once scrolling settles, force-reveal
// anything left invisible that's currently on screen so nothing stays stuck.
let revealSafetyTimer = null;
window.addEventListener('scroll', () => {
  clearTimeout(revealSafetyTimer);
  revealSafetyTimer = setTimeout(() => {
    document.querySelectorAll('.reveal:not(.is-visible)').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        el.classList.add('is-visible');
        if (revealObserver) revealObserver.unobserve(el);
      }
    });
  }, 200);
}, { passive: true });


function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// =========================================================
// SVG icon system — replaces emoji / raw unicode UI symbols
// =========================================================
const ICONS = {
  warning: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3.5l9.5 16.5H2.5L12 3.5z" stroke-linejoin="round"></path><path d="M12 10v4.5" stroke-linecap="round"></path><circle cx="12" cy="17.5" r="0.9" fill="currentColor" stroke="none"></circle></svg>',
  success: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9.5"></circle><path d="M8 12.5l2.6 2.6L16.5 9" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  star: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.2 6.8.7-5.1 4.6 1.5 6.7L12 17.4 5.9 20.7l1.5-6.7-5.1-4.6 6.8-.7L12 2.5z"></path></svg>',
  starEmpty: '<svg class="icon is-empty" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M12 2.5l2.9 6.2 6.8.7-5.1 4.6 1.5 6.7L12 17.4 5.9 20.7l1.5-6.7-5.1-4.6 6.8-.7L12 2.5z"></path></svg>',
  arrowRight: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  externalLink: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M14 4h6v6M20 4L10 14M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  image: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"></rect><circle cx="9" cy="10" r="1.8"></circle><path d="M21 16.5l-5.2-5.2a2 2 0 0 0-2.8 0L5 19" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  post: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 3.5h9l4.5 4.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" stroke-linejoin="round"></path><path d="M8.5 12h7M8.5 15.5h7M8.5 8.5h4"></path></svg>',
  code: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 8l-4.5 4L9 16M15 8l4.5 4-4.5 4" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  layers: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z" stroke-linejoin="round"></path><path d="M3 13l9 5 9-5M3 8.5l9 5 9-5" stroke-linejoin="round"></path></svg>',
  shield: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3l7.5 3v5.5C19.5 16.7 16.3 20 12 21c-4.3-1-7.5-4.3-7.5-9.5V6L12 3z" stroke-linejoin="round"></path><path d="M9 12l2 2 4-4.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  rocket: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 2.5c3 1.2 5 4.3 5 8.2 0 2-.6 4-1.7 5.6L12 20l-3.3-3.7A9.6 9.6 0 0 1 7 10.7c0-3.9 2-7 5-8.2z" stroke-linejoin="round"></path><circle cx="12" cy="10" r="1.8"></circle><path d="M8.5 15.5L6 18M15.5 15.5L18 18" stroke-linecap="round"></path></svg>',
  support: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><circle cx="12" cy="12" r="3.2"></circle><path d="M6.1 6.1l3.2 3.2M17.9 6.1l-3.2 3.2M6.1 17.9l3.2-3.2M17.9 17.9l-3.2-3.2" stroke-linecap="round"></path></svg>',
  device: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="12" height="9" rx="1.2"></rect><path d="M9 17.5h.01M18 8h2.5a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5H18a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" stroke-linecap="round"></path></svg>',
  person: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" stroke-linecap="round"></path></svg>',
  instagram: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1"></circle></svg>'
};

const SERVICE_ICON_MAP = [
  { match: /web|site|frontend|landing/i, icon: ICONS.code },
  { match: /app|mobile|android|ios/i, icon: ICONS.device },
  { match: /cloud|host|deploy|infra/i, icon: ICONS.layers },
  { match: /security|auth|protect/i, icon: ICONS.shield },
  { match: /support|maintain|care/i, icon: ICONS.support },
  { match: /launch|growth|market|speed|performance/i, icon: ICONS.rocket }
];
function iconForService(service) {
  const hay = `${service.icon || ''} ${service.title || ''}`;
  const found = SERVICE_ICON_MAP.find(m => m.match.test(hay));
  return found ? found.icon : ICONS.code;
}

function loadingRow(text, onDark = true) {
  return `<div class="loading-row"><span class="spinner ${onDark ? '' : 'spinner--dark'}"></span> ${escapeHtml(text)}</div>`;
}

function errorRow(text, retryFnName) {
  return `<div class="error-row">${ICONS.warning} ${escapeHtml(text)} <button class="retry-btn" onclick="${retryFnName}()">Retry</button></div>`;
}

function skeletonCards(count, className) {
  return Array.from({ length: count }).map(() => `<div class="skeleton skeleton-card ${className || ''}"></div>`).join('');
}

// =========================================================
// Image handling — consistent loading / fade-in / fallback
// =========================================================
let mediaUid = 0;
function mediaImg({ src, alt, className = '', fallbackIcon = ICONS.image, lazy = true, id }) {
  id = id || `media-${++mediaUid}`;
  if (!src) {
    return `<div class="media ${className}" id="${id}"><div class="media__fallback" aria-hidden="true">${fallbackIcon}</div></div>`;
  }
  return `<div class="media ${className}" id="${id}">
    <div class="media__fallback" aria-hidden="true">${fallbackIcon}</div>
    <img class="media__img" src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}" ${lazy ? 'loading="lazy"' : ''} onload="this.classList.add('is-loaded')" onerror="this.classList.add('is-error')">
  </div>`;
}

// =========================================================
// Blog content sanitization — strips scripts / event handlers / unsafe
// URLs before injecting server-authored HTML into the page.
// =========================================================
const ALLOWED_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'CODE', 'IMG', 'SPAN', 'DIV', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION']);
const ALLOWED_ATTRS = { A: ['href', 'title'], IMG: ['src', 'alt', 'title'] };
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const walk = (node) => {
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED_TAGS.has(child.tagName)) {
          child.replaceWith(...Array.from(child.childNodes));
          return;
        }
        Array.from(child.attributes).forEach(attr => {
          const allowed = ALLOWED_ATTRS[child.tagName] || [];
          const isUnsafeUrl = /^(href|src)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value);
          if (!allowed.includes(attr.name.toLowerCase()) || isUnsafeUrl) child.removeAttribute(attr.name);
        });
        if (child.tagName === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
        walk(child);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    });
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// Some posts are authored as plain text/markdown-ish content (blank-line
// separated paragraphs, "---" dividers) rather than real HTML. Detect that
// and convert it into readable paragraphs instead of one run-on block.
function formatPostContent(raw) {
  const str = String(raw || '');
  const looksLikeHtml = /<(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|figure)\b/i.test(str);
  if (looksLikeHtml) return sanitizeHtml(str);

  const blocks = str.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const html = blocks.map(b => {
    if (/^-{3,}$/.test(b)) return '<hr>';
    return `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return sanitizeHtml(html);
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

function isMenuOpen() { return navLinks?.classList.contains('is-open'); }
function openMenu() {
  if (!navLinks || !navToggle) return;
  navLinks.classList.add('is-open');
  navToggle.classList.add('is-active');
  navToggle.setAttribute('aria-expanded', 'true');
  document.body.classList.add('menu-open');
}
function closeMenu() {
  if (!navLinks || !navToggle) return;
  navLinks.classList.remove('is-open');
  navToggle.classList.remove('is-active');
  navToggle.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
}
navToggle?.addEventListener('click', () => { isMenuOpen() ? closeMenu() : openMenu(); });
navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
document.addEventListener('click', (e) => {
  if (!isMenuOpen()) return;
  if (navLinks.contains(e.target) || navToggle.contains(e.target)) return;
  closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isMenuOpen()) { closeMenu(); navToggle.focus(); }
});

// ---------- Active nav state (scroll-spy via IntersectionObserver) ----------
(function initActiveNav() {
  const navLinkEls = navLinks ? Array.from(navLinks.querySelectorAll('a[href^="#"]')) : [];
  if (!navLinkEls.length || !('IntersectionObserver' in window)) return;
  const sections = navLinkEls
    .map(a => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);
  if (!sections.length) return;

  const setActive = (id) => {
    navLinkEls.forEach(a => a.classList.toggle('is-active', a.getAttribute('href') === `#${id}`));
  };
  const spyObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter(e => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
    if (visible.length) setActive(visible[0].target.id);
  }, { rootMargin: '-45% 0px -50% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });
  sections.forEach(s => spyObserver.observe(s));
})();

// =========================================================
// Company info
// =========================================================
function showSocialLink(id, url) {
  const el = document.getElementById(id);
  if (!el) return;
  const isValidUrl = typeof url === 'string' && /^https?:\/\/.+/i.test(url.trim());
  if (isValidUrl) {
    el.href = url.trim();
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function loadCompanyInfo() {
  try {
    const { company } = await apiGet('/api/company');
    if (!company) return;
    document.getElementById('aboutDescription').textContent = company.description ||
      'SHEREBOY TECH LTD designs, builds and ships modern websites and full-stack web applications for businesses and individuals in Nigeria and beyond.';
    document.getElementById('aboutMission').textContent = company.mission ||
      'To deliver dependable, modern software that helps businesses run better.';
    document.getElementById('aboutVision').textContent = company.vision ||
      'To be a trusted technology partner for ambitious businesses across Africa.';
    document.getElementById('aboutCac').textContent = company.cac_number || 'Registration in progress';
    document.getElementById('ceoName').textContent = company.ceo_name || 'BAWO MADAMEDON';
    document.getElementById('ceoTitle').textContent = company.ceo_title || 'CEO, SHEREBOY TECH LTD';
    document.getElementById('ceoBio').textContent = company.ceo_bio ||
      "Leading SHEREBOY TECH LTD's mission to design and ship modern, reliable software for businesses across Nigeria and beyond.";
    if (company.ceo_photo_url) {
      document.getElementById('ceoPhoto').outerHTML = mediaImg({
        id: 'ceoPhoto', src: company.ceo_photo_url, alt: company.ceo_name || 'CEO photo', className: 'ceo-card__photo', fallbackIcon: ICONS.person, lazy: false
      });
    }
    if (company.email) document.getElementById('contactEmail').href = `mailto:${company.email.replace(/^mailto:/i, '').trim()}`;
    if (company.whatsapp) document.getElementById('contactWhatsapp').href = `https://wa.me/${company.whatsapp.replace(/\D/g, '')}`;
    if (company.phone) document.getElementById('contactCall').href = `tel:${company.phone.replace(/^tel:/i, '').trim()}`;
    showSocialLink('socialInstagram', company.instagram_url);
    showSocialLink('socialTiktok', company.tiktok_url);
    showSocialLink('socialYoutube', company.youtube_url);

    if (company.logo_url) {
      const navLogo = document.getElementById('navLogo');
      const footerLogo = document.getElementById('footerLogo');
      navLogo.onerror = () => { navLogo.hidden = true; };
      navLogo.onload = () => { navLogo.hidden = false; };
      navLogo.src = company.logo_url;
      footerLogo.onerror = () => { footerLogo.hidden = true; };
      footerLogo.onload = () => { footerLogo.hidden = false; };
      footerLogo.src = company.logo_url;
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
    grid.innerHTML = services.map((s, i) => `
      <div class="card card--service reveal reveal-d${Math.min(i % 4, 4)}">
        <div class="service-card__icon" aria-hidden="true">${iconForService(s)}</div>
        <h3>${escapeHtml(s.title)}</h3>
        <p>${escapeHtml(s.description || '')}</p>
      </div>
    `).join('');
    observeReveals(grid);
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
    grid.innerHTML = list.map((p, i) => `
      <div class="project-card reveal reveal-d${Math.min(i % 4, 4)}">
        ${mediaImg({ src: p.image_url, alt: p.title, className: 'media--project' })}
        <div class="project-card__body">
          <p class="project-card__cat">${escapeHtml(p.category || 'Web Project')}</p>
          <h3>${escapeHtml(p.title)}</h3>
          <p>${escapeHtml(p.description || '')}</p>
          <div class="project-card__tech">${(p.technologies || []).map(t => `<span class="tech-chip">${escapeHtml(t)}</span>`).join('')}</div>
          ${p.live_url ? `<a class="project-card__link" href="${escapeHtml(p.live_url)}" target="_blank" rel="noopener" aria-label="View live project: ${escapeHtml(p.title)} (opens in a new tab)">View live project ${ICONS.externalLink}</a>` : ''}
        </div>
      </div>
    `).join('');
    observeReveals(grid);
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
    grid.innerHTML = reviews.map((r, i) => {
      const rating = Math.min(Math.max(parseInt(r.rating, 10) || 5, 1), 5);
      const stars = ICONS.star.repeat(rating) + ICONS.starEmpty.repeat(5 - rating);
      return `
      <div class="card review-card reveal reveal-d${Math.min(i % 4, 4)}">
        <div class="review-card__stars" role="img" aria-label="${rating} out of 5 stars">${stars}</div>
        <p class="review-card__text">"${escapeHtml(r.review_text)}"</p>
        <p class="review-card__name">${escapeHtml(r.client_name || 'Anonymous client')}</p>
        <p class="review-card__pos">${escapeHtml(r.client_position || '')}</p>
      </div>
    `;
    }).join('');
    observeReveals(grid);
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
    grid.innerHTML = posts.map((p, i) => `
      <div class="card reveal reveal-d${Math.min(i % 4, 4)}">
        ${mediaImg({ src: p.featured_image_url, alt: p.title, className: 'media--blog', fallbackIcon: ICONS.post })}
        <p class="blog-card__meta">${new Date(p.created_at).toLocaleDateString()} · ${escapeHtml(p.author || 'SHEREBOY TECH LTD')}</p>
        <h3>${escapeHtml(p.title)}</h3>
        <p>${escapeHtml(p.excerpt || '')}</p>
        <a class="blog-card__link" href="/blog/${escapeHtml(p.slug)}" data-slug="${escapeHtml(p.slug)}">Read post ${ICONS.arrowRight}</a>
      </div>
    `).join('');
    grid.querySelectorAll('[data-slug]').forEach(a => {
      a.addEventListener('click', (e) => { e.preventDefault(); openPost(a.dataset.slug, { openerEl: a }); });
    });
    observeReveals(grid);
  } catch (err) {
    grid.innerHTML = errorRow('Unable to load blog posts right now.', 'loadBlog');
  }
}
loadBlog();

// =========================================================
// Blog post modal
// =========================================================
const postModal = document.getElementById('postModal');
const postModalContent = document.getElementById('postModalContent');
let postModalOpener = null;

async function openPost(slug, { openerEl = null, pushHistory = true } = {}) {
  postModalOpener = openerEl || document.activeElement;
  postModalContent.innerHTML = loadingRow('Loading post…', false);
  postModal.hidden = false;
  document.body.classList.add('menu-open');
  requestAnimationFrame(() => document.getElementById('postModalClose')?.focus());

  try {
    const { post } = await apiGet(`/api/blog/${encodeURIComponent(slug)}`);
    postModalContent.innerHTML = `
      ${post.featured_image_url ? mediaImg({ src: post.featured_image_url, alt: post.title, className: 'media--blog', fallbackIcon: ICONS.post, lazy: false }) : ''}
      <h2>${escapeHtml(post.title)}</h2>
      <p class="post-meta">${new Date(post.created_at).toLocaleDateString()} · ${escapeHtml(post.author || 'SHEREBOY TECH LTD')}</p>
      <div class="post-body">${formatPostContent(post.content)}</div>
    `;
    if (pushHistory) history.pushState({ slug }, '', `/blog/${slug}`);
  } catch (err) {
    postModalContent.innerHTML = `
      <div class="post-state">
        ${ICONS.warning}
        <p>Sorry, that post could not be found or is no longer available.</p>
        <button type="button" class="btn btn--outline" id="postModalBack">Back to blog</button>
      </div>
    `;
    document.getElementById('postModalBack')?.addEventListener('click', closePost);
    if (pushHistory) history.pushState({ slug }, '', `/blog/${slug}`);
    showToast('Could not load that post.', 'error');
  }
}
document.getElementById('postModalClose')?.addEventListener('click', () => closePost());
document.getElementById('postModalBackdrop')?.addEventListener('click', () => closePost());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && postModal && !postModal.hidden) closePost();
});

function closePost({ pushHistory = true } = {}) {
  if (postModal.hidden) return;
  postModal.hidden = true;
  document.body.classList.remove('menu-open');
  if (pushHistory && window.location.pathname !== '/') history.pushState({}, '', '/');
  if (postModalOpener && typeof postModalOpener.focus === 'function') postModalOpener.focus();
  postModalOpener = null;
}

// Back/forward navigation keeps the modal in sync with the URL
window.addEventListener('popstate', () => {
  const match = window.location.pathname.match(/^\/blog\/([a-z0-9-]+)$/i);
  if (match) {
    openPost(match[1], { pushHistory: false });
  } else if (!postModal.hidden) {
    closePost({ pushHistory: false });
  }
});

// Deep-link support: if the page loads on /blog/:slug, open it directly
const blogMatch = window.location.pathname.match(/^\/blog\/([a-z0-9-]+)$/i);
if (blogMatch) openPost(blogMatch[1], { pushHistory: false });

// =========================================================
// AI Chat
// =========================================================
const aiChatForm = document.getElementById('aiChatForm');
const aiChatInput = document.getElementById('aiChatInput');
const aiChatLog = document.getElementById('aiChatLog');
const aiChatSendBtn = aiChatForm?.querySelector('button[type="submit"]');
const AI_HISTORY_KEY = 'shereboy_ai_chat_history';
let chatHistory = [];
let lastUserMessage = '';
let aiSending = false;

function appendMsg(text, cls) {
  const div = document.createElement('div');
  div.className = `ai-msg ${cls}`;
  div.textContent = text;
  aiChatLog.appendChild(div);
  aiChatLog.scrollTop = aiChatLog.scrollHeight;
  return div;
}

function appendErrorMsg(text) {
  const div = document.createElement('div');
  div.className = 'ai-msg ai-msg--error';
  div.innerHTML = `<span>${escapeHtml(text)}</span>`;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'retry-btn';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => { div.remove(); sendAiMessage(lastUserMessage); });
  div.appendChild(retry);
  aiChatLog.appendChild(div);
  aiChatLog.scrollTop = aiChatLog.scrollHeight;
  return div;
}

function appendTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'ai-msg ai-msg--bot ai-msg--typing';
  div.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  aiChatLog.appendChild(div);
  aiChatLog.scrollTop = aiChatLog.scrollHeight;
  return div;
}

function saveChatHistory() {
  try { sessionStorage.setItem(AI_HISTORY_KEY, JSON.stringify(chatHistory)); } catch (e) { /* storage unavailable — non-critical */ }
}

(function restoreChatHistory() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(AI_HISTORY_KEY) || '[]');
    if (Array.isArray(saved) && saved.length) {
      chatHistory = saved;
      saved.forEach(m => appendMsg(m.text, m.role === 'user' ? 'ai-msg--user' : 'ai-msg--bot'));
    }
  } catch (e) { /* corrupt/unavailable storage — start fresh */ }
})();

async function sendAiMessage(message) {
  if (!message || aiSending) return;
  aiSending = true;
  lastUserMessage = message;
  appendMsg(message, 'ai-msg--user');
  chatHistory.push({ role: 'user', text: message });
  saveChatHistory();
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
    saveChatHistory();
  } catch (err) {
    typingEl.remove();
    appendErrorMsg(err.message || 'The assistant is unavailable right now.');
  } finally {
    aiChatInput.disabled = false;
    setButtonLoading(aiChatSendBtn, false);
    aiChatInput.focus();
    aiSending = false;
  }
}

// Auto-resize the textarea as the visitor types, up to a max height (CSS-capped)
aiChatInput?.addEventListener('input', () => {
  aiChatInput.style.height = 'auto';
  aiChatInput.style.height = `${aiChatInput.scrollHeight}px`;
});
// Enter sends the message; Shift+Enter inserts a newline
aiChatInput?.addEventListener('keydown', (e) => {
  const isEnter = e.key === 'Enter' || e.keyCode === 13;
  if (isEnter && !e.shiftKey) {
    e.preventDefault();
    aiChatForm?.requestSubmit();
  }
});

aiChatForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = aiChatInput.value.trim();
  if (!message) return;
  aiChatInput.value = '';
  aiChatInput.style.height = 'auto';
  sendAiMessage(message);
});

// =========================================================
// Contact form
// =========================================================
const contactForm = document.getElementById('contactForm');
const contactStatus = document.getElementById('contactFormStatus');
const contactSubmitBtn = document.getElementById('contactSubmitBtn');
let contactSubmitting = false;

contactForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (contactSubmitting) return;
  contactSubmitting = true;
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
    contactStatus.innerHTML = `${ICONS.success}<span>${escapeHtml(successMsg)}</span>`;
    contactStatus.className = 'contact-form__status contact-form__status--success';
    contactStatus.hidden = false;
    contactForm.reset();
    showToast(successMsg, 'success');
  } catch (err) {
    contactStatus.innerHTML = `${ICONS.warning}<span>${escapeHtml(err.message)}</span>`;
    contactStatus.className = 'contact-form__status contact-form__status--error';
    contactStatus.hidden = false;
    showToast(err.message, 'error');
    contactForm.classList.remove('shake');
    void contactForm.offsetWidth; // restart animation if triggered again
    contactForm.classList.add('shake');
  } finally {
    setButtonLoading(contactSubmitBtn, false);
    contactSubmitting = false;
  }
});