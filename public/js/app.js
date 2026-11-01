// public/js/app.js
// SHEREBOY TECH LTD — public site. Vanilla JS, no dependencies.
// Every piece of company data (projects, services, reviews, posts, company
// details, founder photo, CAC certificate) comes from the REST API; the markup
// only carries sensible fallbacks. No secrets ever live here, and no inline
// event handlers are used (the site runs under a strict Content-Security-Policy).

(function () {
  'use strict';

  // Each page's HTML holds only that page's sections. Code for a section that isn't
  // on this page gets a detached placeholder element, so it simply has no effect.
  const placeholders = new Map();
  const $ = (sel, root = document) => {
    const found = root.querySelector(sel);
    if (found || root !== document || !/^#[\w-]+$/.test(sel)) return found;
    if (!placeholders.has(sel)) placeholders.set(sel, document.createElement('div'));
    return placeholders.get(sel);
  };
  const onPage = (id) => !!document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const prefersReducedMotion = document.documentElement.classList.contains('reduced-motion');
  const PAGE = document.body.dataset.page || 'home';
  const START_PATH = location.pathname;

  $('#year').textContent = new Date().getFullYear();

  // =========================================================
  // Utilities
  // =========================================================
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function icon(name, cls = '') {
    return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }
  function paragraphs(text) {
    return String(text || '').split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${escapeHtml(p)}</p>`).join('');
  }
  function isHttpUrl(url) { return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim()); }
  function safeHref(url) {
    if (!url) return '';
    const u = String(url).trim();
    if (u.startsWith('/') && !u.startsWith('//')) return u;
    return isHttpUrl(u) ? u : '';
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
  // Runs fn when el nears the viewport, or a few seconds after load as a safety net
  function whenNear(el, fn, rootMargin = '800px 0px') {
    let started = false;
    const start = () => { if (!started) { started = true; fn(); } };
    if (!el || !('IntersectionObserver' in window)) { start(); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { io.disconnect(); start(); }
    }, { rootMargin });
    io.observe(el);
    const later = () => setTimeout(() => { io.disconnect(); start(); }, 4000);
    if (document.readyState === 'complete') later(); else window.addEventListener('load', later, { once: true });
  }
  function hostOf(url) { try { return new URL(url, location.origin).host; } catch { return ''; } }
  function formatDate(d, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
    const date = new Date(d);
    return isNaN(date) ? '' : date.toLocaleDateString('en-GB', opts);
  }

  const toastStack = $('#toastStack');
  function showToast(message, type = 'info', duration = 4500) {
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    toastStack.appendChild(toast);
    setTimeout(() => { toast.classList.add('is-leaving'); setTimeout(() => toast.remove(), 220); }, duration);
  }

  function setButtonLoading(btn, loading, text = 'Please wait…') {
    if (!btn) return;
    if (loading) {
      btn.dataset.originalHtml = btn.dataset.originalHtml || btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${escapeHtml(text)}`;
    } else {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    }
  }

  async function apiGet(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // Images: a fallback sits behind every image; the image fades in on load and
  // hides itself on error so a broken URL never shows a broken-image icon.
  function mediaHtml({ src, alt = '', className = '', fallback = 'image', eager = false, sizes }) {
    const safe = safeHref(src);
    return `<div class="media media--loading ${className}">
      <div class="media__fallback" aria-hidden="true">${icon(fallback)}</div>
      ${safe ? `<img class="media__img" src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" ${eager ? '' : 'loading="lazy"'} decoding="async" ${sizes ? `sizes="${sizes}"` : ''}>` : ''}
    </div>`;
  }
  function hydrateMedia(root = document) {
    $$('img.media__img:not([data-hydrated])', root).forEach(img => {
      img.dataset.hydrated = '1';
      const box = img.closest('.media');
      const done = (ok) => {
        img.classList.add(ok ? 'is-loaded' : 'is-error');
        if (ok) box?.classList.add('media--ready');
        box?.classList.remove('media--loading');
        if (!ok) console.warn('[media] image failed to load:', img.currentSrc || img.src);
      };
      if (img.complete && img.getAttribute('src')) done(img.naturalWidth > 0);
      else {
        img.addEventListener('load', () => done(true), { once: true });
        img.addEventListener('error', () => done(false), { once: true });
      }
      if (!img.getAttribute('src')) box?.classList.remove('media--loading');
    });
  }

  function errorState(message, retryId) {
    return `<div class="error-state">${icon('warning')}<span>${escapeHtml(message)}</span><button type="button" class="retry-btn" data-retry="${retryId}">Try again</button></div>`;
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-retry]');
    if (!btn) return;
    ({ services: loadServices, projects: loadProjects })[btn.dataset.retry]?.();
  });

  // =========================================================
  // Scroll reveal
  // =========================================================
  const revealObserver = ('IntersectionObserver' in window && !prefersReducedMotion)
    ? new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); revealObserver.unobserve(entry.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' })
    : null;

  function observeReveals(root = document) {
    const els = $$('.reveal:not(.is-visible)', root);
    // Stagger siblings that enter together
    els.forEach((el, i) => { if (!el.style.getPropertyValue('--d')) el.style.setProperty('--d', `${Math.min(i % 4, 3) * 0.07}s`); });
    if (!revealObserver) { els.forEach(el => el.classList.add('is-visible')); return; }
    els.forEach(el => revealObserver.observe(el));
  }
  observeReveals();
  // Safety net: fast jumps (anchor links, find-in-page) can skip the observer
  let revealTimer;
  window.addEventListener('scroll', () => {
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      $$('.reveal:not(.is-visible)').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.top < innerHeight && r.bottom > 0) { el.classList.add('is-visible'); revealObserver?.unobserve(el); }
      });
    }, 150);
  }, { passive: true });

  // Animated counters — only ever count up to real values from the API
  function animateCount(el, target) {
    if (!el || !Number.isFinite(target)) return;
    if (prefersReducedMotion || !('IntersectionObserver' in window)) { el.textContent = target; return; }
    const run = () => {
      const start = performance.now();
      const dur = 1100;
      const step = (now) => {
        const t = Math.min((now - start) / dur, 1);
        el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3)));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { io.disconnect(); run(); } }, { threshold: 0.6 });
    io.observe(el);
  }

  // =========================================================
  // Navigation
  // =========================================================
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 12);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const drawer = $('#navDrawer');
  const navToggle = $('#navToggle');
  function openDrawer() {
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    navToggle.setAttribute('aria-expanded', 'true');
    lockScroll(true);
    setTimeout(() => $('.drawer__links a', drawer)?.focus({ preventScroll: true }), 80);
  }
  function closeDrawer({ restoreFocus = true } = {}) {
    if (!drawer.classList.contains('is-open')) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    navToggle.setAttribute('aria-expanded', 'false');
    lockScroll(false);
    if (restoreFocus) navToggle.focus();
  }
  navToggle.addEventListener('click', openDrawer);
  $$('[data-close-drawer]', drawer).forEach(el => el.addEventListener('click', () => closeDrawer()));
  $$('a', drawer).forEach(a => a.addEventListener('click', () => closeDrawer({ restoreFocus: false })));
  window.matchMedia('(min-width: 1000px)').addEventListener?.('change', (e) => { if (e.matches) closeDrawer({ restoreFocus: false }); });

  // Scroll lock that survives nested overlays
  let lockCount = 0;
  function lockScroll(on) {
    lockCount = Math.max(0, lockCount + (on ? 1 : -1));
    document.body.classList.toggle('no-scroll', lockCount > 0);
  }

  // Scroll-spy for the desktop nav
  (function initScrollSpy() {
    const links = $$('.nav__links a[data-nav]');
    const sections = links.map(a => document.getElementById(a.dataset.nav)).filter(Boolean);
    if (PAGE !== 'home' || !('IntersectionObserver' in window) || !sections.length) return;
    const setActive = (id) => links.forEach(a => {
      const on = a.dataset.nav === id;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
    const io = new IntersectionObserver((entries) => {
      entries.filter(e => e.isIntersecting).forEach(e => setActive(e.target.id));
    }, { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach(s => io.observe(s));
  })();

  // "Start a Project" buttons: scroll to the form and focus the first field
  function goToEnquiry(projectType) {
    if (!onPage('contact')) {
      location.href = `/contact${projectType ? `?type=${encodeURIComponent(projectType)}` : ''}#contact`;
      return;
    }
    const select = $('#efType');
    if (projectType && select && [...select.options].some(o => o.value === projectType || o.text === projectType)) {
      select.value = projectType;
      clearFieldError(select);
    }
    $('#contact').scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
    setTimeout(() => $('#efName')?.focus({ preventScroll: true }), prefersReducedMotion ? 0 : 650);
  }
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-start-project]');
    if (!trigger) return;
    e.preventDefault();
    closeDrawer({ restoreFocus: false });
    goToEnquiry(trigger.dataset.projectType);
  });

  // =========================================================
  // Generic dialog handling (focus trap, Escape, focus restore)
  // =========================================================
  const openDialogs = [];
  function openDialog(el, { opener, onClose } = {}) {
    if (!el.hidden) return;
    el.hidden = false;
    openDialogs.push({ el, opener: opener || document.activeElement, onClose });
    lockScroll(true);
    requestAnimationFrame(() => ($('[data-autofocus]', el) || $('button, [href], input, textarea, select', el))?.focus());
  }
  function closeDialog(el, { restoreFocus = true } = {}) {
    const idx = openDialogs.findIndex(d => d.el === el);
    if (idx === -1) return;
    const [entry] = openDialogs.splice(idx, 1);
    el.hidden = true;
    lockScroll(false);
    entry.onClose?.();
    if (restoreFocus && entry.opener && document.contains(entry.opener)) entry.opener.focus?.();
  }
  document.addEventListener('keydown', (e) => {
    const top = openDialogs[openDialogs.length - 1];
    if (e.key === 'Escape') {
      if (top) { if (document.fullscreenElement) return; e.preventDefault(); closeDialog(top.el); return; }
      if (drawer.classList.contains('is-open')) { closeDrawer(); return; }
      if (!assistant.hidden) { closeAssistant(); }
      return;
    }
    if (e.key === 'Tab') {
      const container = top ? top.el : (drawer.classList.contains('is-open') ? $('.drawer__panel', drawer) : null);
      if (!container) return;
      const focusables = $$('a[href], button:not([disabled]), input:not([type="hidden"]), select, textarea, iframe, [tabindex]:not([tabindex="-1"])', container)
        .filter(n => n.offsetParent !== null || n === document.activeElement);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close-modal]');
    if (closer) { const dlg = closer.closest('.modal'); if (dlg) closeDialog(dlg); }
  });

  // =========================================================
  // Company information
  // =========================================================
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
  function localPhone(v) {
    let d = digits(v);
    if (d.startsWith('234')) d = `0${d.slice(3)}`;
    return d.length === 11 ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : String(v || '').replace(/^tel:/i, '');
  }
  function intlPhone(v) {
    let d = digits(v);
    if (d.startsWith('0')) d = `234${d.slice(1)}`;
    return d;
  }
  function cityFromAddress(address) {
    const parts = String(address || '').split(',').map(s => s.trim()).filter(p => p && !/^nigeria$/i.test(p));
    return parts.slice(-2).join(', ');
  }

  function setText(sel, value) { $$(sel).forEach(el => { el.textContent = value; }); }

  async function loadCompany() {
    let company;
    try {
      ({ company } = await apiGet('/api/company'));
    } catch (err) {
      console.error('Company info unavailable:', err.message);
      renderCertificate(null);
      return;
    }
    if (!company) { renderCertificate(null); return; }

    if (company.description) $('#aboutDescription').innerHTML = paragraphs(company.description);
    if (company.mission) $('#aboutMission').textContent = company.mission;
    if (company.vision) $('#aboutVision').textContent = company.vision;

    if (company.core_values && company.core_values.trim()) {
      $('#coreValues').innerHTML = company.core_values.split('\n').map(v => v.trim()).filter(Boolean)
        .map(v => `<li>${escapeHtml(v)}</li>`).join('');
    }

    if (company.ceo_name) {
      setText('#ceoName', company.ceo_name.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase()));
      $('#founderImg').alt = `${company.ceo_name}, founder of ${company.company_name || 'SHEREBOY TECH LTD'}`;
    }
    if (company.ceo_title) setText('#ceoTitle', company.ceo_title);
    if (company.ceo_bio) renderBio(company.ceo_bio);

    const founderImg = $('#founderImg');
    const photo = safeHref(company.ceo_photo_url);
    if (photo) {
      founderImg.hidden = false;
      founderImg.src = photo;
      $('#founderMedia').classList.add('media--loading');
      hydrateMedia($('#founderMedia'));
    }

    // Registration
    const rc = (company.cac_number || '').trim();
    const hasRc = rc && !/^\[.*\]$/.test(rc);
    if (hasRc) {
      setText('#regNumber', rc); setText('#footerRc', rc);
      $('#statRc').textContent = `RC ${rc}`;
      $('#heroRc').textContent = ` · RC ${rc}`;
    } else {
      $('#heroRc').textContent = '';
      $('#statRc').textContent = 'Registered';
    }
    if (company.company_name) setText('#regName', company.company_name);
    if (company.address && !/^\[.*\]$/.test(company.address)) {
      setText('#regAddress', company.address);
      setText('[data-company-text="address"]', company.address.replace(/,\s*Nigeria$/i, ''));
      const city = cityFromAddress(company.address);
      if (city) $('#statLocation').textContent = city;
    }
    renderCertificate(company.cac_document_url);

    // Contact channels
    const email = String(company.email || '').replace(/^mailto:/i, '').trim();
    if (email) {
      $$('[data-company-link="email"]').forEach(a => { a.href = `mailto:${email}`; });
      setText('[data-company-text="email"]', email);
    }
    if (company.whatsapp) {
      const wa = intlPhone(company.whatsapp);
      $$('[data-company-link="whatsapp"]').forEach(a => { a.href = `https://wa.me/${wa}`; });
      setText('[data-company-text="whatsapp"]', localPhone(company.whatsapp));
    }
    if (company.phone) {
      $$('[data-company-link="phone"]').forEach(a => { a.href = `tel:+${intlPhone(company.phone)}`; });
      setText('[data-company-text="phone"]', localPhone(company.phone));
    }
    $$('[data-social]').forEach(a => {
      const url = company[a.dataset.social];
      if (isHttpUrl(url)) { a.href = url.trim(); a.hidden = false; } else { a.hidden = true; }
    });
  }

  function renderBio(bio) {
    const el = $('#ceoBio');
    const toggle = $('#ceoBioToggle');
    el.innerHTML = paragraphs(bio);
    if (bio.length > 520) {
      el.classList.add('is-clamped');
      toggle.hidden = false;
      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        el.classList.toggle('is-clamped', expanded);
        toggle.firstChild.textContent = expanded ? 'Read full profile ' : 'Show less ';
      });
    }
  }

  // ---------- CAC certificate ----------
  // The original document is displayed exactly as supplied: object-fit: contain
  // inside the certificate's own aspect ratio — never cropped, filtered or redrawn.
  let certificateUrl = '';
  function isPdf(url) { return /\.pdf($|[?#])/i.test(url); }
  function renderCertificate(url) {
    const card = $('#certificateCard');
    const box = $('#certificateMedia');
    certificateUrl = safeHref(url);
    if (!certificateUrl) {
      card.classList.add('certificate--missing');
      box.innerHTML = `<div class="media__fallback">${icon('doc')}<span>Certificate available on request</span></div>`;
      $('#certificateOpen').disabled = true;
      $('#certificateOpen2').hidden = true;
      return;
    }
    if (isPdf(certificateUrl)) {
      box.innerHTML = `<div class="media__fallback">${icon('doc')}<span>PDF document · tap to view</span></div>`;
      return;
    }
    box.innerHTML = `<div class="media__fallback">${icon('doc')}<span>Loading certificate…</span></div>
      <img class="media__img" src="${escapeHtml(certificateUrl)}" alt="SHEREBOY TECH LTD Certificate of Incorporation issued by the Corporate Affairs Commission" loading="lazy" decoding="async">`;
    box.classList.add('media--loading');
    const img = $('img', box);
    img.addEventListener('error', () => {
      $('.media__fallback span', box).textContent = 'The certificate image could not be loaded. Open the original instead.';
    }, { once: true });
    hydrateMedia(box);
  }
  function openCertificate(opener) {
    if (!certificateUrl) return;
    const body = $('#docModalBody');
    const zoomBtn = $('#docZoom');
    $('#docOpen').href = certificateUrl;
    body.classList.remove('is-zoomed');
    zoomBtn.setAttribute('aria-pressed', 'false');
    if (isPdf(certificateUrl)) {
      zoomBtn.hidden = true;
      body.innerHTML = `<iframe src="${escapeHtml(certificateUrl)}#view=FitH" title="Certificate of Incorporation (PDF)"></iframe>`;
    } else {
      zoomBtn.hidden = false;
      body.innerHTML = `<img src="${escapeHtml(certificateUrl)}" alt="SHEREBOY TECH LTD Certificate of Incorporation issued by the Corporate Affairs Commission">`;
      $('img', body).addEventListener('click', toggleDocZoom);
    }
    openDialog($('#docModal'), { opener });
  }
  function toggleDocZoom() {
    const body = $('#docModalBody');
    const on = !body.classList.contains('is-zoomed');
    body.classList.toggle('is-zoomed', on);
    $('#docZoom').setAttribute('aria-pressed', String(on));
  }
  $('#docZoom').addEventListener('click', toggleDocZoom);
  $('#certificateOpen').addEventListener('click', (e) => openCertificate(e.currentTarget));
  $('#certificateOpen2').addEventListener('click', (e) => openCertificate(e.currentTarget));

  // =========================================================
  // Services
  // =========================================================
  const SERVICE_TYPES = [
    { test: /mobile|android|\bios\b/i, icon: 'mobile', type: 'Mobile application' },
    // Case-sensitive "AI" so words like "maintenance" don't match
    { test: /\bAI\b|[Aa]rtificial|[Aa]utomat|[Ii]ntelligen/, icon: 'spark', type: 'Something else' },
    { test: /\bapi\b|integration/i, icon: 'api', type: 'API / integration' },
    { test: /maint|support|care/i, icon: 'support', type: 'Maintenance & support' },
    { test: /commerce|shop|affiliate|store/i, icon: 'cart', type: 'Website' },
    { test: /management|system|erp|crm|inventory/i, icon: 'system', type: 'Business management system' },
    { test: /custom software|full.?stack|software/i, icon: 'code', type: 'Custom software' },
    { test: /web\s*app|application|portal|dashboard/i, icon: 'app', type: 'Web application' },
    { test: /web|site/i, icon: 'web', type: 'Website' }
  ];
  function serviceMeta(s) {
    const hay = `${s.icon || ''} ${s.title || ''}`;
    return SERVICE_TYPES.find(m => m.test.test(hay)) || { icon: 'layers', type: 'Something else' };
  }

  async function loadServices() {
    const list = $('#servicesList');
    // Server-rendered cards stay in place until fresh ones arrive
    if (!$('.service', list)) list.innerHTML = '<div class="skeleton skeleton--service"></div><div class="skeleton skeleton--service"></div><div class="skeleton skeleton--service"></div>';
    try {
      const { services } = await apiGet('/api/services');
      const items = services || [];
      animateCount($('#statServices'), items.length);
      if (!items.length) { list.innerHTML = '<p class="empty-state">Our services will be listed here shortly.</p>'; return; }
      list.innerHTML = items.map((s, i) => {
        const meta = serviceMeta(s);
        const benefits = Array.isArray(s.benefits) ? s.benefits.filter(Boolean) : [];
        const wide = items.length % 2 === 1 && i === 0;
        return `<article class="service ${wide ? 'service--wide' : ''}">
          <span class="service__icon">${icon(meta.icon)}</span>
          <span class="service__num">${String(i + 1).padStart(2, '0')}</span>
          <h3>${escapeHtml(s.title)}</h3>
          <p class="service__desc">${escapeHtml(s.description || '')}</p>
          ${benefits.length ? `<ul class="service__benefits">${benefits.map(b => `<li>${icon('check')}<span>${escapeHtml(b)}</span></li>`).join('')}</ul>` : ''}
          <a href="/contact" class="link-btn service__cta" data-start-project data-project-type="${escapeHtml(meta.type)}">Discuss this service ${icon('arrow')}</a>
        </article>`;
      }).join('');
      $('#footerServices').innerHTML = items.slice(0, 5).map(s => `<a href="/services">${escapeHtml(s.title)}</a>`).join('');
      observeReveals(list);
    } catch (err) {
      list.innerHTML = errorState('We could not load our services right now.', 'services');
    }
  }

  // =========================================================
  // Projects / portfolio
  // =========================================================
  const CATEGORY_GROUPS = ['Websites', 'Web Applications', 'Mobile Applications', 'Business Software', 'Other Projects'];
  function categoryGroup(category) {
    const c = String(category || '').trim();
    const exact = CATEGORY_GROUPS.find(g => g.toLowerCase() === c.toLowerCase());
    if (exact) return exact;
    if (/mobile|android|\bios\b/i.test(c)) return 'Mobile Applications';
    if (/web\s*app|application|platform|portal|dashboard|saas/i.test(c)) return 'Web Applications';
    if (/business|management|erp|crm|inventory|\bpos\b|software|system/i.test(c)) return 'Business Software';
    if (/web\s*site|site|landing|church|portfolio/i.test(c)) return 'Websites';
    return 'Other Projects';
  }
  const STATUS_LABELS = { completed: 'Completed', in_progress: 'In progress', maintenance: 'Ongoing support' };

  let projects = [];
  let projectList = [];
  let activeFilter = 'All';

  async function loadProjects() {
    const grid = $('#workGrid');
    if (!$('.project', grid)) grid.innerHTML = '<div class="skeleton skeleton--project skeleton--wide"></div><div class="skeleton skeleton--project"></div><div class="skeleton skeleton--project"></div>';
    try {
      const data = await apiGet('/api/projects?limit=50');
      projects = data.projects || [];
      animateCount($('#statProjects'), data.total ?? projects.length);
      // A project's own page lists the other projects
      projectList = PAGE === 'project' ? projects.filter(p => START_PATH !== `/projects/${p.id}`) : projects;
      renderFilters();
      renderProjects();
      routeFromLocation();
    } catch (err) {
      grid.innerHTML = errorState('We could not load our projects right now.', 'projects');
    }
  }

  function renderFilters() {
    const wrap = $('#workFilters');
    const counts = {};
    projectList.forEach(p => { const g = categoryGroup(p.category); counts[g] = (counts[g] || 0) + 1; });
    const groups = CATEGORY_GROUPS.filter(g => counts[g]);
    // Filtering only helps when there is more than one category with projects
    if (groups.length < 2) { wrap.hidden = true; return; }
    wrap.hidden = false;
    wrap.innerHTML = [['All', projectList.length], ...groups.map(g => [g, counts[g]])].map(([g, n]) =>
      `<button type="button" class="filter ${g === activeFilter ? 'is-active' : ''}" role="tab" aria-selected="${g === activeFilter}" data-filter="${escapeHtml(g)}">${escapeHtml(g)} <span>${n}</span></button>`
    ).join('');
  }
  $('#workFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    $$('.filter', e.currentTarget).forEach(b => { const on = b === btn; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on)); });
    renderProjects();
  });

  function canPreview(p) { return !!safeHref(p.live_url) && p.preview_enabled !== false; }

  function projectCard(p, lead) {
    const status = STATUS_LABELS[p.status] || STATUS_LABELS.completed;
    const tech = (p.technologies || []).slice(0, lead ? 8 : 5);
    return `<article class="project reveal ${lead ? 'project--lead' : ''}">
      <div class="project__media" data-open-project="${escapeHtml(p.id)}" aria-hidden="true">
        <div class="project__badges">
          ${p.featured ? `<span class="badge badge--featured">${icon('star')}Featured</span>` : '<span></span>'}
          <span class="badge status status--${escapeHtml(p.status || 'completed')}">${status}</span>
        </div>
        ${mediaHtml({ src: p.image_url, alt: '', fallback: 'image' })}
      </div>
      <div class="project__body">
        <p class="project__cat">${escapeHtml(p.category || categoryGroup(p.category))}</p>
        <h3 class="project__title"><a href="/projects/${escapeHtml(p.id)}" data-open-project="${escapeHtml(p.id)}">${escapeHtml(p.title)}</a></h3>
        <p class="project__desc">${escapeHtml((p.description || '').split('\n').filter(Boolean)[0] || '')}</p>
        ${tech.length ? `<div class="chips" aria-label="Technologies used">${tech.map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        <div class="project__actions">
          <button type="button" class="btn btn--ghost btn--sm" data-open-project="${escapeHtml(p.id)}">View Project</button>
          ${canPreview(p) ? `<button type="button" class="btn btn--primary btn--sm" data-preview-project="${escapeHtml(p.id)}">${icon('eye')}Live Preview</button>` : ''}
        </div>
      </div>
    </article>`;
  }

  function renderProjects() {
    const grid = $('#workGrid');
    const list = activeFilter === 'All' ? projectList : projectList.filter(p => categoryGroup(p.category) === activeFilter);
    if (!list.length) {
      grid.innerHTML = '<p class="empty-state">New projects will be showcased here soon.</p>';
      return;
    }
    // The first project gets the editorial "lead" layout when there's an odd number of cards
    grid.innerHTML = list.map((p, i) => projectCard(p, i === 0 && list.length % 2 === 1)).join('');
    hydrateMedia(grid);
    observeReveals(grid);
  }

  document.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open-project]');
    if (openBtn) {
      // Real link (crawlable, opens in a new tab with a modifier key); plain clicks open the details in place
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      openProject(openBtn.dataset.openProject, { opener: openBtn });
      return;
    }
    const prevBtn = e.target.closest('[data-preview-project]');
    if (prevBtn) {
      const p = projects.find(x => x.id === prevBtn.dataset.previewProject);
      if (p) openPreview(p, prevBtn);
    }
  });

  // ---------- Project details modal (/projects/:id) ----------
  const projectModal = $('#projectModal');
  function openProject(id, { opener, pushHistory = true } = {}) {
    const p = projects.find(x => x.id === id);
    if (!p) return false;
    const live = safeHref(p.live_url);
    const repo = safeHref(p.github_url);
    $('#projectModalBody').innerHTML = `
      ${mediaHtml({ src: p.image_url, alt: `${p.title} — screenshot`, className: 'pd__media', eager: true })}
      <div class="pd__body">
        <p class="project__cat">${escapeHtml(p.category || categoryGroup(p.category))}</p>
        <h2 class="pd__title" id="projectModalTitle">${escapeHtml(p.title)}</h2>
        <dl class="pd__facts">
          <div><dt>Status</dt><dd><span class="status status--${escapeHtml(p.status || 'completed')}">${STATUS_LABELS[p.status] || 'Completed'}</span></dd></div>
          ${p.client_name ? `<div><dt>Client</dt><dd>${escapeHtml(p.client_name)}</dd></div>` : ''}
          ${p.completion_date ? `<div><dt>Completed</dt><dd>${formatDate(p.completion_date, { month: 'long', year: 'numeric' })}</dd></div>` : ''}
          ${live ? `<div><dt>Website</dt><dd>${escapeHtml(hostOf(live))}</dd></div>` : ''}
        </dl>
        <div class="pd__desc">${paragraphs(p.description)}</div>
        ${(p.technologies || []).length ? `<div><h3 class="sub-title">Technologies used</h3><div class="chips">${p.technologies.map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div></div>` : ''}
        <div class="pd__actions">
          ${canPreview(p) ? `<button type="button" class="btn btn--primary" data-preview-project="${escapeHtml(p.id)}">${icon('eye')}Live Preview</button>` : ''}
          ${live ? `<a class="btn btn--ghost" href="${escapeHtml(live)}" target="_blank" rel="noopener">Visit Website ${icon('external')}</a>` : ''}
          ${repo ? `<a class="btn btn--ghost" href="${escapeHtml(repo)}" target="_blank" rel="noopener">${icon('github')}View Source</a>` : ''}
          <a class="btn btn--ghost" href="/contact" data-start-project>Start a similar project</a>
        </div>
      </div>`;
    hydrateMedia(projectModal);
    $('#projectModalBody').scrollTop = 0;
    openDialog(projectModal, {
      opener,
      onClose: () => { if (location.pathname !== START_PATH) history.pushState({}, '', START_PATH); }
    });
    $('.modal__panel', projectModal).scrollTop = 0;
    if (pushHistory && location.pathname !== `/projects/${id}`) history.pushState({ project: id }, '', `/projects/${id}`);
    return true;
  }
  // Closing via a CTA inside the modal
  projectModal.addEventListener('click', (e) => {
    if (e.target.closest('[data-start-project]')) closeDialog(projectModal, { restoreFocus: false });
  });

  // ---------- Live preview ----------
  const previewModal = $('#previewModal');
  const previewWrap = $('#previewFrameWrap');
  const previewState = $('#previewState');
  const previewDevice = $('#previewDevice');
  const preview = { project: null, token: 0, timers: [] };
  // Real viewport widths: the site inside the frame lays out exactly as on that
  // device, and the frame is then scaled down to fit the space available here.
  const DEVICE_WIDTHS = { desktop: 1280, tablet: 820, mobile: 390 };
  const previewStage = $('#previewStage');

  function fitPreview() {
    if (previewModal.hidden) return;
    const device = previewDevice.dataset.device;
    const pad = document.fullscreenElement ? 0 : 14;
    const availW = previewStage.clientWidth - pad * 2;
    const availH = previewStage.clientHeight - pad * 2;
    if (availW <= 0 || availH <= 0) return;
    // Desktop fills the space when it is wider than the logical width
    const width = device === 'desktop' ? Math.max(DEVICE_WIDTHS.desktop, availW) : DEVICE_WIDTHS[device];
    const scale = Math.min(1, availW / width);
    previewDevice.style.width = `${width}px`;
    previewDevice.style.height = `${availH / scale}px`;
    previewDevice.style.transform = `translateX(-50%) scale(${scale})`;
  }
  if ('ResizeObserver' in window) new ResizeObserver(fitPreview).observe(previewStage);
  else window.addEventListener('resize', fitPreview);

  function clearPreviewTimers() { preview.timers.forEach(clearTimeout); preview.timers = []; }

  function setDevice(device) {
    previewDevice.dataset.device = device;
    $$('[data-device]', previewModal).forEach(b => {
      if (b === previewDevice) return;
      const on = b.dataset.device === device;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    fitPreview();
  }
  $$('.preview__devices [data-device]').forEach(b => b.addEventListener('click', () => setDevice(b.dataset.device)));

  function showPreviewState(html) { previewState.innerHTML = html; previewState.hidden = false; }
  function hidePreviewState() { previewState.hidden = true; previewState.innerHTML = ''; }

  function loadingState(text) {
    return `<div class="preview__loader" aria-hidden="true"></div>
      <h3>${escapeHtml(text)}</h3>
      <p id="previewHint">Loading ${escapeHtml(hostOf(preview.project.live_url))}</p>
      <div class="preview__progress" aria-hidden="true"><span></span></div>`;
  }

  function fallbackState({ title, message, warn = true, retry = true, wait = false }) {
    const p = preview.project;
    const live = safeHref(p.live_url);
    showPreviewState(`
      ${p.image_url ? mediaHtml({ src: p.image_url, alt: `${p.title} — screenshot`, className: 'preview__state-thumb', eager: true }) : `<span class="state-icon ${warn ? 'state-icon--warn' : ''}">${icon(warn ? 'lock' : 'web')}</span>`}
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      <div class="preview__state-actions">
        <a class="btn btn--primary" href="${escapeHtml(live)}" target="_blank" rel="noopener">Open Website ${icon('external')}</a>
        ${wait ? '<button type="button" class="btn btn--ghost" data-preview-wait>Keep waiting</button>' : ''}
        ${retry ? `<button type="button" class="btn btn--ghost" data-preview-retry>${icon('refresh')}Try again</button>` : ''}
      </div>`);
    hydrateMedia(previewState);
  }
  previewState.addEventListener('click', (e) => {
    if (e.target.closest('[data-preview-retry]')) loadPreview({ fresh: true });
    if (e.target.closest('[data-preview-wait]')) {
      showPreviewState(loadingState('Still loading…'));
      armTimeout(preview.token, 30000);
    }
  });

  function armTimeout(token, ms) {
    clearPreviewTimers();
    preview.timers.push(setTimeout(() => {
      if (token !== preview.token) return;
      const hint = $('#previewHint');
      if (hint) hint.textContent = 'Some websites take a few seconds to start up — thanks for your patience.';
    }, Math.min(8000, ms / 2)));
    preview.timers.push(setTimeout(() => {
      if (token !== preview.token) return;
      fallbackState({
        title: 'This website is taking longer than expected',
        message: 'It may be starting up or experiencing a slow connection. You can keep waiting, try again, or open it in a new tab.',
        wait: true
      });
    }, ms));
  }

  function blockedState(p, disabled) {
    fallbackState({
      title: disabled ? 'Live preview is not available for this project' : 'This website can\'t be displayed inside another site',
      message: disabled
        ? 'You can still visit the website directly.'
        : `${hostOf(p.live_url)} doesn't allow other websites to display it, and that choice is respected here. Open the website to explore it directly.`,
      retry: false
    });
  }

  async function loadPreview({ fresh = false } = {}) {
    const p = preview.project;
    const token = ++preview.token;
    clearPreviewTimers();
    previewWrap.innerHTML = '';
    showPreviewState(loadingState('Preparing live preview…'));

    let check = { embeddable: null };
    try {
      check = await apiGet(`/api/projects/${encodeURIComponent(p.id)}/preview-check${fresh ? '?r=' + Date.now() : ''}`);
    } catch { /* treat as unknown — we still try the frame */ }
    if (token !== preview.token) return;

    if (check.embeddable === false) {
      blockedState(p, check.disabled);
      return;
    }

    showPreviewState(loadingState('Loading website…'));
    const iframe = document.createElement('iframe');
    iframe.title = `Live preview of ${p.title}`;
    // Only what a normal website needs to run; no top-level navigation of our page
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttribute('allow', 'fullscreen');
    iframe.addEventListener('load', async () => {
      if (token !== preview.token) return;
      clearPreviewTimers();
      // Browsers fire "load" even when a site refuses to be framed, so if we
      // could not confirm embedding up-front, re-check now that the site is awake.
      if (check.embeddable === null) {
        let again = { embeddable: null };
        try { again = await apiGet(`/api/projects/${encodeURIComponent(p.id)}/preview-check?r=${Date.now()}`); } catch { /* keep unknown */ }
        if (token !== preview.token) return;
        if (again.embeddable === false) {
          previewWrap.innerHTML = '';
          blockedState(p);
          return;
        }
      }
      hidePreviewState();
    });
    iframe.src = safeHref(p.live_url);
    previewWrap.appendChild(iframe);
    // Sleeping hosts (unknown status) get longer before we call it slow
    armTimeout(token, check.embeddable === null ? 45000 : 20000);
  }

  function openPreview(project, opener) {
    preview.project = project;
    const live = safeHref(project.live_url);
    $('#previewTitle').textContent = project.title;
    $('#previewUrl').textContent = hostOf(live);
    $('#previewNewTab').href = live;
    // The preview sits above the details modal if that is open
    openDialog(previewModal, {
      opener,
      onClose: () => {
        preview.token += 1;
        clearPreviewTimers();
        previewWrap.innerHTML = '';
        hidePreviewState();
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      }
    });
    setDevice(innerWidth < 700 ? 'mobile' : (innerWidth < 1100 ? 'tablet' : 'desktop'));
    loadPreview();
  }
  $('#previewClose').addEventListener('click', () => closeDialog(previewModal));
  $('#previewRefresh').addEventListener('click', () => loadPreview({ fresh: true }));
  $('#previewFullscreen').addEventListener('click', () => {
    if (!document.fullscreenEnabled) { showToast('Full screen is not supported on this device.', 'info'); return; }
    if (document.fullscreenElement) document.exitFullscreen();
    else previewModal.requestFullscreen?.().catch(() => showToast('Full screen was blocked by your browser.', 'error'));
  });
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    $('#previewFullscreen').innerHTML = icon(on ? 'shrink' : 'expand');
    $('#previewFullscreen').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    fitPreview();
  });

  // =========================================================
  // Reviews (only real, published reviews; section stays hidden otherwise)
  // =========================================================
  function reviewText(text) {
    // Reviews may contain simple **bold** markdown — escape first, then format
    return String(text || '').split(/\n\s*\n|\n/).map(t => t.trim()).filter(Boolean)
      .map(t => `<p>${escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`).join('');
  }
  async function loadReviews() {
    try {
      const { reviews } = await apiGet('/api/reviews');
      if (!reviews || !reviews.length) return;
      const list = $('#reviewsList');
      list.classList.toggle('reviews--single', reviews.length === 1);
      list.innerHTML = reviews.slice(0, 6).map(r => {
        const rating = Math.min(Math.max(parseInt(r.rating, 10) || 5, 1), 5);
        return `<figure class="review reveal">
          <div class="review__stars" role="img" aria-label="Rated ${rating} out of 5">${icon('star').repeat(rating)}${icon('star', 'is-empty').repeat(5 - rating)}</div>
          <blockquote class="review__text">${reviewText(r.review_text)}</blockquote>
          <figcaption class="review__who">
            ${mediaHtml({ src: r.client_image_url, alt: '', className: 'review__avatar', fallback: 'user' })}
            <div><strong>${escapeHtml(r.client_name)}</strong><span>${escapeHtml(r.client_position || '')}</span></div>
          </figcaption>
        </figure>`;
      }).join('');
      $('#reviews').hidden = false;
      hydrateMedia(list);
      observeReveals($('#reviews'));
    } catch { /* optional section — stays hidden */ }
  }

  // =========================================================
  // Insights — read-only feed from SHEREBOY BLOG
  // Articles are written and hosted on SHEREBOY BLOG; this site only shows
  // summaries (fetched and cached by our server) and links to the original.
  // =========================================================
  const blogFeedEl = $('#blogFeed');

  // Our server wakes SHEREBOY BLOG and SHEREBOY AFFILIATE CONCEPT in the background.
  // While it does, a feed answers "waking" immediately and the page asks again on
  // this schedule, then stops: there is no endless polling.
  const FEED_RETRY_MS = [3000, 5000, 8000, 12000, 18000, 25000, 30000];
  const FEED_SAVE_KEY = (name) => `shereboy_feed_${name}`;
  const FEED_SAVE_MAX_MS = 6 * 3600 * 1000;
  function saveFeed(name, data) {
    try { localStorage.setItem(FEED_SAVE_KEY(name), JSON.stringify({ at: Date.now(), data })); } catch { /* optional */ }
  }
  function savedFeed(name) {
    try {
      const saved = JSON.parse(localStorage.getItem(FEED_SAVE_KEY(name)) || 'null');
      return saved && Date.now() - saved.at < FEED_SAVE_MAX_MS ? saved.data : null;
    } catch { return null; }
  }
  function wakingHtml(title, message) {
    return `<div class="feed-waking" role="status"><div class="preview__loader" aria-hidden="true"></div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`;
  }

  function articleMeta(a) {
    return [
      a.publishedAt ? `<time datetime="${escapeHtml(a.publishedAt)}">${formatDate(a.publishedAt, { day: 'numeric', month: 'long', year: 'numeric' })}</time>` : '',
      a.author ? `<span>${escapeHtml(a.author.name)}</span>` : '',
      a.readingTimeMinutes ? `<span>${a.readingTimeMinutes} min read</span>` : ''
    ].filter(Boolean).join('<span aria-hidden="true">·</span>');
  }

  function blogMedia(a, eager) {
    // Missing or broken images fall back to a neutral SHEREBOY BLOG placeholder (never a fake image)
    return `<div class="media blog-media media--loading">
      <div class="media__fallback blog-media__fallback" aria-hidden="true">${icon('doc')}<span>SHEREBOY BLOG</span></div>
      ${a.image ? `<img class="media__img" src="${escapeHtml(a.image.url)}" alt="${escapeHtml(a.image.alt || a.title)}" ${eager ? '' : 'loading="lazy"'} decoding="async">` : ''}
    </div>`;
  }

  function articleCard(a, featured) {
    const href = escapeHtml(safeHref(a.url));
    const readLabel = escapeHtml(`Read more: ${a.title} (opens on SHEREBOY BLOG)`);
    return `<article class="${featured ? 'blog-featured' : 'blog-card'} reveal">
      <a class="blog-card__media" href="${href}" tabindex="-1" aria-hidden="true">${blogMedia(a, featured)}
        ${featured ? '<span class="blog-featured__flag">Featured</span>' : ''}</a>
      <div class="blog-card__body">
        ${a.category ? `<span class="blog-card__cat">${escapeHtml(a.category.name)}</span>` : ''}
        <h3 class="blog-card__title"><a href="${href}">${escapeHtml(a.title)}</a></h3>
        ${a.excerpt ? `<p class="blog-card__excerpt">${escapeHtml(a.excerpt)}</p>` : ''}
        <p class="blog-card__meta">${articleMeta(a)}</p>
        <a class="${featured ? 'btn btn--primary blog-card__cta' : 'blog-card__more'}" href="${href}" aria-label="${readLabel}">Read More ${icon('arrow')}</a>
      </div>
    </article>`;
  }

  function blogState({ title, message, retry }) {
    blogFeedEl.innerHTML = `<div class="blog-state">
      <span class="blog-state__icon">${icon(retry ? 'warning' : 'doc')}</span>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      <div class="blog-state__actions">
        ${retry ? `<button type="button" class="btn btn--ghost" data-blog-retry>${icon('refresh')}Try again</button>` : ''}
        <a class="btn btn--primary" href="${escapeHtml($('[data-blog-home]').getAttribute('href'))}">Visit SHEREBOY BLOG ${icon('arrow-up-right')}</a>
      </div>
    </div>`;
  }

  function renderArticles(articles, note) {
    const lead = articles.find(a => a.isFeatured) || articles[0];
    const rest = articles.filter(a => a !== lead).slice(0, 6);
    blogFeedEl.innerHTML = articleCard(lead, true) + (rest.length ? `<div class="blog-grid">${rest.map(a => articleCard(a, false)).join('')}</div>` : '');
    $('#blogFeedNote').textContent = note;
    hydrateMedia(blogFeedEl);
    observeReveals(blogFeedEl);
  }

  let blogRetryTimer = null;
  let blogShowingSaved = false;
  async function loadBlogFeed(attempt = 0) {
    clearTimeout(blogRetryTimer);
    blogFeedEl.setAttribute('aria-busy', 'true');
    if (attempt === 0) blogShowingSaved = false;
    if (attempt === 0 && !$('.blog-card, .blog-featured', blogFeedEl)) blogFeedEl.innerHTML = '<div class="skeleton skeleton--featured"></div><div class="skeleton skeleton--post"></div><div class="skeleton skeleton--post"></div><div class="skeleton skeleton--post"></div>';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch('/api/blog-feed', { headers: { Accept: 'application/json' }, signal: controller.signal });
      const feed = await res.json();
      if (!res.ok || !feed || !Array.isArray(feed.articles)) throw new Error('bad response');
      const home = safeHref(feed.blogUrl);
      if (home) $$('[data-blog-home]').forEach(a => { a.href = `${home}/`; });

      if (feed.status === 'waking') {
        if (attempt < FEED_RETRY_MS.length) {
          const saved = savedFeed('blog');
          if (saved && saved.length && !blogShowingSaved) {
            blogShowingSaved = true;
            renderArticles(saved, 'Showing recently saved articles while SHEREBOY BLOG starts up.');
          } else if (!blogShowingSaved) {
            blogFeedEl.innerHTML = wakingHtml('SHEREBOY BLOG is starting up', 'The latest articles will appear here shortly. This can take up to a minute or so.');
          }
          blogRetryTimer = setTimeout(() => loadBlogFeed(attempt + 1), FEED_RETRY_MS[attempt]);
          return;
        }
        feed.status = 'unavailable';
      }
      if (feed.status === 'unavailable') {
        if (blogShowingSaved) return;
        blogState({ title: 'Articles are temporarily unavailable', message: 'We couldn\'t reach SHEREBOY BLOG just now. You can try again, or read the latest articles directly on the blog.', retry: true });
        return;
      }
      const articles = feed.articles.filter(a => a && a.title && safeHref(a.url));
      if (!articles.length) {
        blogState({ title: 'Fresh articles coming soon', message: 'New insights are on the way. Visit SHEREBOY BLOG for more updates.' });
        return;
      }
      saveFeed('blog', articles);
      renderArticles(articles, feed.status === 'stale'
        ? 'Showing recently saved articles while SHEREBOY BLOG updates. Articles are hosted on SHEREBOY BLOG.'
        : 'Articles are written, published and hosted on SHEREBOY BLOG.');
    } catch {
      blogState({ title: 'Articles are temporarily unavailable', message: 'We couldn\'t load the latest articles right now. Please try again, or visit SHEREBOY BLOG directly.', retry: true });
    } finally {
      clearTimeout(timer);
      blogFeedEl.setAttribute('aria-busy', 'false');
    }
  }
  blogFeedEl.addEventListener('click', (e) => { if (e.target.closest('[data-blog-retry]')) loadBlogFeed(); });

  // Load when the section approaches the viewport, or a few seconds after the page
  // settles (safety net for jumps the observer can miss). Answered from our server's
  // in-memory cache, so this never adds load to SHEREBOY BLOG itself.
  if (onPage('insights')) {
    if (location.hash === '#insights') loadBlogFeed();
    else whenNear($('#insights'), () => loadBlogFeed());
  }

  // =========================================================
  // Client-side route: /projects/:id
  // =========================================================
  function routeFromLocation() {
    const projectMatch = location.pathname.match(/^\/projects\/([\w-]+)\/?$/);
    // A project's own address, loaded directly, is a full page; only later
    // in-page navigation opens the details view
    if (projectMatch && location.pathname !== START_PATH) {
      openProject(projectMatch[1], { pushHistory: false });
    } else if (!projectModal.hidden) {
      closeDialog(projectModal, { restoreFocus: false });
    }
  }
  window.addEventListener('popstate', routeFromLocation);

  // =========================================================
  // Project enquiry form
  // =========================================================
  const form = $('#enquiryForm');
  const status = $('#enquiryStatus');
  const submitBtn = $('#enquirySubmit');
  const message = $('#efMessage');
  const VALIDATORS = {
    efName: (v) => v.trim().length >= 2 ? '' : 'Please enter your full name.',
    efEmail: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? '' : 'Please enter a valid email address.',
    efPhone: (v) => !v.trim() || /^[+()\d\s-]{7,20}$/.test(v.trim()) ? '' : 'Please enter a valid phone number.',
    efType: (v) => v ? '' : 'Please choose the type of project.',
    efMessage: (v) => v.trim().length >= 10 ? '' : 'Please describe your project (at least 10 characters).'
  };
  function setFieldError(input, msg) {
    const field = input.closest('.field');
    field.classList.toggle('has-error', !!msg);
    const err = $(`#${input.id}Error`);
    if (err) err.textContent = msg;
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) input.setAttribute('aria-describedby', `${input.id}Error`); else input.removeAttribute('aria-describedby');
  }
  function clearFieldError(input) { setFieldError(input, ''); }
  Object.keys(VALIDATORS).forEach(id => {
    const input = $(`#${id}`);
    input.addEventListener('blur', () => { if (input.value) setFieldError(input, VALIDATORS[id](input.value)); });
    input.addEventListener('input', () => { if (input.closest('.field').classList.contains('has-error')) setFieldError(input, VALIDATORS[id](input.value)); });
  });
  const askedType = new URLSearchParams(location.search).get('type');
  if (askedType && onPage('efType')) {
    const select = $('#efType');
    if ([...select.options].some(o => o.value === askedType || o.text === askedType)) select.value = askedType;
    if (location.hash === '#contact') setTimeout(() => $('#efName').focus({ preventScroll: true }), 300);
  }
  message.addEventListener('input', () => { $('#efCount').textContent = `${message.value.length} / 3000`; });

  let submitting = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    status.hidden = true;
    let firstInvalid = null;
    Object.entries(VALIDATORS).forEach(([id, fn]) => {
      const input = $(`#${id}`);
      const msg = fn(input.value);
      setFieldError(input, msg);
      if (msg && !firstInvalid) firstInvalid = input;
    });
    if (firstInvalid) {
      firstInvalid.focus();
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
      return;
    }
    submitting = true;
    setButtonLoading(submitBtn, true, 'Sending…');
    const payload = {
      name: $('#efName').value.trim(),
      email: $('#efEmail').value.trim(),
      phone: $('#efPhone').value.trim(),
      project_type: $('#efType').value,
      message: message.value.trim(),
      website: $('#efWebsite').value
    };
    try {
      const res = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'We could not send your enquiry. Please try again.');
      status.className = 'form-status form-status--success';
      status.innerHTML = `${icon('check')}<span>${escapeHtml(data.message || 'Thank you — your enquiry has been received.')}</span>`;
      status.hidden = false;
      form.reset();
      $('#efCount').textContent = '0 / 3000';
      showToast('Enquiry sent successfully.', 'success');
    } catch (err) {
      const msg = err.message === 'Failed to fetch' ? 'You appear to be offline. Please check your connection and try again.' : err.message;
      status.className = 'form-status form-status--error';
      status.innerHTML = `${icon('warning')}<span>${escapeHtml(msg)}</span>`;
      status.hidden = false;
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    } finally {
      submitting = false;
      setButtonLoading(submitBtn, false);
    }
  });

  // =========================================================
  // AI assistant (server-side Gemini proxy at /api/ai/chat)
  // =========================================================
  const assistant = $('#assistant');
  const assistantFab = $('#assistantOpen');
  const chatForm = $('#aiChatForm');
  const chatInput = $('#aiChatInput');
  const chatLog = $('#aiChatLog');
  const chatSend = $('button[type="submit"]', chatForm);
  const AI_HISTORY_KEY = 'shereboy_ai_chat_history';
  let chatHistory = [];
  let lastUserMessage = '';
  let aiSending = false;

  function openAssistant() {
    assistant.hidden = false;
    assistantFab.classList.add('is-hidden');
    assistantFab.setAttribute('aria-expanded', 'true');
    chatInput.focus();
  }
  function closeAssistant() {
    assistant.hidden = true;
    assistantFab.classList.remove('is-hidden');
    assistantFab.setAttribute('aria-expanded', 'false');
    assistantFab.focus();
  }
  assistantFab.addEventListener('click', openAssistant);
  $('#assistantClose').addEventListener('click', closeAssistant);

  function appendMsg(text, cls) {
    const div = document.createElement('div');
    div.className = `ai-msg ${cls}`;
    div.textContent = text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }
  function saveChat() { try { sessionStorage.setItem(AI_HISTORY_KEY, JSON.stringify(chatHistory.slice(-20))); } catch { /* non-critical */ } }
  try {
    const saved = JSON.parse(sessionStorage.getItem(AI_HISTORY_KEY) || '[]');
    if (Array.isArray(saved)) { chatHistory = saved; saved.forEach(m => appendMsg(m.text, m.role === 'user' ? 'ai-msg--user' : 'ai-msg--bot')); }
  } catch { /* start fresh */ }

  async function sendAiMessage(text) {
    if (!text || aiSending) return;
    aiSending = true;
    lastUserMessage = text;
    appendMsg(text, 'ai-msg--user');
    const historyForRequest = chatHistory.slice(-6);
    chatHistory.push({ role: 'user', text });
    saveChat();
    chatInput.disabled = true;
    chatSend.disabled = true;
    const typing = document.createElement('div');
    typing.className = 'ai-msg ai-msg--bot';
    typing.innerHTML = '<span class="typing-dots" aria-label="Assistant is typing"><span></span><span></span><span></span></span>';
    chatLog.appendChild(typing);
    chatLog.scrollTop = chatLog.scrollHeight;
    try {
      const res = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, history: historyForRequest }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The assistant is unavailable right now.');
      typing.remove();
      appendMsg(data.reply, 'ai-msg--bot');
      chatHistory.push({ role: 'assistant', text: data.reply });
      saveChat();
    } catch (err) {
      typing.remove();
      const div = document.createElement('div');
      div.className = 'ai-msg ai-msg--error';
      div.innerHTML = `<span>${escapeHtml(err.message)}</span>`;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry-btn';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => { div.remove(); chatHistory.pop(); chatLog.lastElementChild?.remove(); sendAiMessage(lastUserMessage); });
      div.appendChild(retry);
      chatLog.appendChild(div);
      chatLog.scrollTop = chatLog.scrollHeight;
    } finally {
      chatInput.disabled = false;
      chatSend.disabled = false;
      chatInput.focus();
      aiSending = false;
    }
  }
  chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`; });
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); } });
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    chatInput.style.height = 'auto';
    sendAiMessage(text);
  });

  // =========================================================
  // Affiliate products — read-only feed from SHEREBOY AFFILIATE CONCEPT
  // Products are managed on the affiliate platform; this site only shows them
  // (via our server's cache) and links each one to its own destination there.
  // =========================================================
  function formatPrice(amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
    try {
      return new Intl.NumberFormat('en-NG', { style: 'currency', currency: currency || 'NGN', maximumFractionDigits: amount >= 100 ? 0 : 2 }).format(amount);
    } catch {
      return `${currency || 'NGN'} ${amount.toLocaleString('en-NG')}`;
    }
  }

  function productCard(p) {
    const href = safeHref(p.url);
    // Partner-store tracking links are marked sponsored; referrer is kept so attribution still works
    const rel = p.urlType === 'partner-store' ? 'noopener sponsored' : 'noopener';
    const name = escapeHtml(p.name);
    const price = p.price || {};
    const now = formatPrice(price.current, price.currency);
    const was = price.previous ? formatPrice(price.previous, price.currency) : '';
    const media = `<div class="media product__img media--loading">
        <div class="media__fallback product__placeholder" aria-hidden="true">${icon('cart')}<span>Image coming soon</span></div>
        ${p.image ? `<img class="media__img" src="${escapeHtml(p.image.url)}" alt="${escapeHtml(p.image.alt || p.name)}" loading="lazy" decoding="async">` : ''}
      </div>
      <div class="product__badges">
        ${p.isFeatured ? `<span class="badge badge--featured">${icon('star')}Featured</span>` : (p.isDeal ? '<span class="badge badge--deal">Deal</span>' : '<span></span>')}
        ${was && price.discountPercent ? `<span class="badge badge--save">−${price.discountPercent}%</span>` : ''}
      </div>`;
    return `<article class="product reveal">
      ${href ? `<a class="product__media" href="${escapeHtml(href)}" target="_blank" rel="${rel}" tabindex="-1" aria-hidden="true">${media}</a>` : `<div class="product__media">${media}</div>`}
      <div class="product__body">
        ${p.category ? `<span class="product__cat">${escapeHtml(p.category.name)}</span>` : ''}
        <h3 class="product__name">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="${rel}">${name}</a>` : name}</h3>
        ${p.description ? `<p class="product__desc">${escapeHtml(p.description)}</p>` : ''}
        ${now ? `<p class="product__price"><strong>${now}</strong>${was ? `<s aria-label="Previous price ${was}">${was}</s>` : ''}</p>` : ''}
        ${p.availability === 'limited' ? '<p class="product__stock">Limited stock</p>' : ''}
        ${href
    ? `<a class="btn btn--primary btn--sm product__cta" href="${escapeHtml(href)}" target="_blank" rel="${rel}" aria-label="Explore ${name} on SHEREBOY AFFILIATE CONCEPT (opens in a new tab)">Explore Product ${icon('arrow-up-right')}</a>`
    : '<span class="btn btn--sm product__cta is-disabled" aria-disabled="true">Currently unavailable</span>'}
      </div>
    </article>`;
  }

  function productSkeletons(n) {
    return Array.from({ length: n }, () => '<div class="skeleton skeleton--product"></div>').join('');
  }

  function setAffiliateHome(url) {
    const home = safeHref(url);
    if (home) $$('[data-aff-home]').forEach(a => { a.href = `${home}/`; });
  }

  // ---------- Homepage: Featured Products (hidden unless real products exist) ----------
  async function loadHomeProducts(attempt = 0) {
    const section = $('#featured-products');
    const grid = $('#homeProducts');
    try {
      const res = await fetch('/api/affiliate-feed/featured?limit=4', { headers: { Accept: 'application/json' } });
      const feed = await res.json();
      // Hidden until there is something real to show; ask again while the platform wakes
      if (res.ok && feed.status === 'waking' && attempt < FEED_RETRY_MS.length) {
        setTimeout(() => loadHomeProducts(attempt + 1), FEED_RETRY_MS[attempt]);
        return;
      }
      if (!res.ok || !Array.isArray(feed.products) || !feed.products.length) return; // stay hidden — never an empty or broken block
      grid.innerHTML = feed.products.map(productCard).join('');
      section.hidden = false;
      hydrateMedia(grid);
      observeReveals(section);
    } catch { /* optional section — stays hidden if the affiliate platform is unavailable */ }
  }

  // ---------- /affiliate-products: showcase page ----------
  const aff = { q: '', category: '', page: 1, pageSize: 12, loading: false, ctrl: null, firstLoad: !location.search };

  function affState({ title, message, retry, clear }) {
    const store = $('[data-aff-home]').getAttribute('href');
    $('#affGrid').innerHTML = `<div class="blog-state">
      <span class="blog-state__icon">${icon(retry ? 'warning' : 'cart')}</span>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      <div class="blog-state__actions">
        ${retry ? `<button type="button" class="btn btn--ghost" data-aff-retry>${icon('refresh')}Try again</button>` : ''}
        ${clear ? `<button type="button" class="btn btn--ghost" data-aff-clear>${icon('close')}Clear search &amp; filters</button>` : ''}
        <a class="btn btn--primary" href="${escapeHtml(store)}" target="_blank" rel="noopener">Visit SHEREBOY AFFILIATE CONCEPT ${icon('arrow-up-right')}</a>
      </div>
    </div>`;
  }

  function syncAffUrl() {
    const params = new URLSearchParams();
    if (aff.q) params.set('q', aff.q);
    if (aff.category) params.set('category', aff.category);
    const qs = params.toString();
    history.replaceState(null, '', `/affiliate-products${qs ? `?${qs}` : ''}`);
  }

  function renderAffCategories(categories, total) {
    const wrap = $('#affCategories');
    if (!categories.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    wrap.innerHTML = [['', 'All', total], ...categories.map(c => [c.slug, c.name, c.count])].map(([slug, label, n]) =>
      `<button type="button" class="filter ${slug === aff.category ? 'is-active' : ''}" data-aff-cat="${escapeHtml(slug)}" aria-pressed="${slug === aff.category}">${escapeHtml(label)} <span>${n}</span></button>`
    ).join('');
  }

  let affRetryTimer = null;
  async function loadAffProducts({ append = false, attempt = 0 } = {}) {
    clearTimeout(affRetryTimer);
    const grid = $('#affGrid');
    const more = $('#affLoadMore');
    if (aff.ctrl) aff.ctrl.abort();
    const ctrl = new AbortController();
    aff.ctrl = ctrl;
    aff.loading = true;
    grid.setAttribute('aria-busy', 'true');
    if (append) setButtonLoading(more, true, 'Loading…');
    else if (attempt === 0) {
      // Server-rendered products stay in place while the first request runs
      if (!(aff.firstLoad && $('.product', grid))) grid.innerHTML = productSkeletons(6);
      aff.firstLoad = false;
      more.hidden = true;
    }

    const params = new URLSearchParams({ page: aff.page, pageSize: aff.pageSize });
    if (aff.q) params.set('q', aff.q);
    if (aff.category) params.set('category', aff.category);
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(`/api/affiliate-feed/products?${params}`, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      const feed = await res.json();
      if (!res.ok || !Array.isArray(feed.products)) throw new Error(feed.error || 'bad response');
      setAffiliateHome(feed.siteUrl);

      if (feed.status === 'waking') {
        if (attempt < FEED_RETRY_MS.length) {
          const saved = !aff.q && !aff.category ? savedFeed('products') : null;
          if (saved && saved.length) {
            if (attempt === 0) {
              grid.innerHTML = saved.map(productCard).join('');
              hydrateMedia(grid);
              observeReveals(grid);
              $('#affCount').textContent = 'Showing a recently saved list while SHEREBOY AFFILIATE CONCEPT starts up.';
            }
          } else {
            $('#affCount').textContent = '';
            grid.innerHTML = wakingHtml('SHEREBOY AFFILIATE CONCEPT is starting up', 'Products will appear here shortly. This can take up to a minute or so.');
          }
          affRetryTimer = setTimeout(() => loadAffProducts({ attempt: attempt + 1 }), FEED_RETRY_MS[attempt]);
          return;
        }
        feed.status = 'unavailable';
      }
      if (feed.status === 'unavailable') {
        $('#affCount').textContent = '';
        $('#affCategories').hidden = true;
        affState({ title: 'Products are temporarily unavailable', message: 'We couldn\'t reach SHEREBOY AFFILIATE CONCEPT just now. Please try again, or browse the products directly on the affiliate website.', retry: true });
        return;
      }
      renderAffCategories(feed.categories || [], feed.catalogueSize || 0);
      const { total, hasMore } = feed.pagination;
      if (!total) {
        $('#affCount').textContent = '';
        if (aff.q || aff.category) affState({ title: 'No products match your search', message: aff.q ? `We couldn't find products matching “${aff.q}”. Try another word or clear the filters.` : 'There are no products in this category right now.', clear: true });
        else affState({ title: 'New products are on the way', message: 'New products are on the way. Visit SHEREBOY AFFILIATE CONCEPT for the latest offers.' });
        return;
      }
      if (!append && !aff.q && !aff.category) saveFeed('products', feed.products);
      const html = feed.products.map(productCard).join('');
      if (append) {
        grid.insertAdjacentHTML('beforeend', html);
      } else {
        grid.innerHTML = html;
      }
      const shown = grid.querySelectorAll('.product').length;
      $('#affCount').textContent = `Showing ${shown} of ${total} product${total === 1 ? '' : 's'}${feed.status === 'stale' ? ' · recently saved list' : ''}`;
      more.hidden = !hasMore;
      hydrateMedia(grid);
      observeReveals(grid);
    } catch (err) {
      if (ctrl.signal.aborted && aff.ctrl !== ctrl) return; // superseded by a newer search
      affState({ title: 'Products are temporarily unavailable', message: 'We couldn\'t load products right now. Please try again, or visit SHEREBOY AFFILIATE CONCEPT directly.', retry: true });
    } finally {
      clearTimeout(timer);
      if (aff.ctrl === ctrl) {
        aff.loading = false;
        grid.setAttribute('aria-busy', 'false');
        setButtonLoading(more, false);
      }
    }
  }

  async function loadAffFeatured(attempt = 0) {
    try {
      const res = await fetch('/api/affiliate-feed/featured?limit=8', { headers: { Accept: 'application/json' } });
      const feed = await res.json();
      if (res.ok && feed.status === 'waking' && attempt < FEED_RETRY_MS.length) {
        setTimeout(() => loadAffFeatured(attempt + 1), FEED_RETRY_MS[attempt]);
        return;
      }
      const featured = (feed.products || []).filter(p => p.isFeatured);
      const wrap = $('#affFeaturedWrap');
      if (!res.ok || !featured.length) { wrap.hidden = true; return; }
      $('#affFeatured').innerHTML = featured.slice(0, 4).map(productCard).join('');
      wrap.hidden = !!(aff.q || aff.category);
      hydrateMedia(wrap);
      observeReveals(wrap);
    } catch { $('#affFeaturedWrap').hidden = true; }
  }

  function applyAffFilters() {
    aff.page = 1;
    syncAffUrl();
    // Featured strip only on the unfiltered view
    if ($('#affFeatured').children.length) $('#affFeaturedWrap').hidden = !!(aff.q || aff.category);
    loadAffProducts();
  }

  function initAffiliatePage() {
    const params = new URLSearchParams(location.search);
    aff.q = (params.get('q') || '').slice(0, 80);
    const cat = params.get('category') || '';
    aff.category = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cat) ? cat : '';
    $('#affSearch').value = aff.q;
    $$('[data-nav-page="affiliate"]').forEach(a => { a.classList.add('is-active'); a.setAttribute('aria-current', 'page'); });

    const onSearch = debounce(() => {
      const next = $('#affSearch').value.trim().slice(0, 80);
      if (next === aff.q) return;
      aff.q = next;
      applyAffFilters();
    }, 300);
    $('#affSearch').addEventListener('input', onSearch);
    $('#affToolbar').addEventListener('submit', (e) => { e.preventDefault(); aff.q = $('#affSearch').value.trim().slice(0, 80); applyAffFilters(); });
    $('#affCategories').addEventListener('click', (e) => {
      const b = e.target.closest('[data-aff-cat]');
      if (!b || b.dataset.affCat === aff.category) return;
      aff.category = b.dataset.affCat;
      applyAffFilters();
    });
    $('#affLoadMore').addEventListener('click', () => { if (!aff.loading) { aff.page += 1; loadAffProducts({ append: true }); } });
    $('#affGrid').addEventListener('click', (e) => {
      if (e.target.closest('[data-aff-retry]')) loadAffProducts();
      if (e.target.closest('[data-aff-clear]')) { aff.q = ''; aff.category = ''; $('#affSearch').value = ''; applyAffFilters(); }
    });

    loadAffFeatured();
    loadAffProducts();
  }

  // =========================================================
  // Boot
  // =========================================================
  loadCompany();
  if (PAGE === 'affiliate') initAffiliatePage();
  if (onPage('servicesList')) loadServices();
  if (onPage('workGrid')) loadProjects();
  if (onPage('reviews')) loadReviews();
  if (onPage('featured-products')) whenNear($('#featured-products'), () => loadHomeProducts());
  hydrateMedia();
})();
