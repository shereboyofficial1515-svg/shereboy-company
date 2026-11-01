// server/seo.js
// Server-side pages and search-engine files. Every public page uses one HTML
// shell (public/index.html) and this module tailors it per URL:
//   * keeps only the sections marked for that page (<!-- page:... --> blocks)
//   * sets its <title>, description, canonical URL, Open Graph tags and heading
//   * fills in real services, projects and company text so that the content is
//     present before any JavaScript runs (app.js then keeps it up to date)
//   * adds structured data built only from real company records
// Also serves /sitemap.xml, /robots.txt and a real 404 page.
const fs = require('fs');
const path = require('path');
const supabase = require('./database');
const blogFeed = require('./blogFeed');
const affiliateFeed = require('./affiliateFeed');
const errorLog = require('./errorLog');

const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');
const SITE = () => (process.env.SITE_URL || 'https://shereboytechltd.site').split(',')[0].trim().replace(/\/+$/, '');
const COMPANY = 'SHEREBOY TECH LTD';

let indexCache = null;
function indexHtml() {
  // Re-read in development so edits show up without a restart
  if (!indexCache || process.env.NODE_ENV !== 'production') indexCache = fs.readFileSync(INDEX_PATH, 'utf8');
  return indexCache;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
// JSON-LD is embedded as data; "<" is escaped so stored text can never close the script element
const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const isReal = (v) => typeof v === 'string' && !!v.trim() && !/^PLACEHOLDER_|^\[.*\]$/.test(v.trim());
const isWebUrl = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- Page definitions ----------
const PAGES = {
  home: {
    path: '/',
    title: `${COMPANY} | Software Development & Digital Solutions`,
    description: `${COMPANY} builds professional websites, mobile applications, custom software and digital solutions that help businesses grow and operate efficiently.`
  },
  about: {
    path: '/about',
    crumb: 'About',
    heading: 'aboutTitle',
    title: `About ${COMPANY} | Our Company and Vision`,
    description: `Learn about ${COMPANY}, a registered technology company in Nigeria: our mission, our vision, our founder and our Certificate of Incorporation.`
  },
  services: {
    path: '/services',
    crumb: 'Services',
    heading: 'servicesTitle',
    title: `Software Development Services | ${COMPANY}`,
    description: `Website design and development, web application development, mobile app development and custom business software from ${COMPANY}, a software development company in Nigeria.`
  },
  projects: {
    path: '/projects',
    crumb: 'Projects',
    heading: 'workTitle',
    title: `Our Projects | ${COMPANY}`,
    description: `Explore websites, web applications and business software designed and built by ${COMPANY}, with live previews where the website allows them.`
  },
  contact: {
    path: '/contact',
    crumb: 'Contact',
    heading: 'contactTitle',
    title: `Contact ${COMPANY} | Start Your Project`,
    description: `Tell ${COMPANY} about your website, web application or business software project. Send an enquiry and get a reply from our team.`
  },
  affiliate: {
    path: '/affiliate-products',
    crumb: 'Affiliate Products',
    title: `Affiliate Products | ${COMPANY}`,
    description: `Explore a curated collection of products from SHEREBOY AFFILIATE CONCEPT, presented by ${COMPANY} to help you discover useful products and exciting offers.`
  }
};

// ---------- Real site data (short cache so pages never wait on every view) ----------
const DATA_TTL_MS = 5 * 60 * 1000;
const DATA_WAIT_MS = 2500;
const site = { company: null, services: [], projects: [], at: 0, inFlight: null };

function refreshSiteData() {
  if (site.inFlight) return site.inFlight;
  site.inFlight = (async () => {
    const [company, services, projects] = await Promise.all([
      supabase.from('company_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('services').select('*').eq('published', true).order('display_order', { ascending: true }),
      supabase.from('projects').select('*').eq('published', true).order('featured', { ascending: false }).limit(50)
    ]);
    if (company.error || services.error || projects.error) throw new Error('Could not read site data');
    site.company = company.data || null;
    site.services = services.data || [];
    site.projects = projects.data || [];
    site.at = Date.now();
  })().catch((err) => {
    errorLog.record('seo', err.message);
    console.warn('[seo] site data refresh failed:', err.message);
  }).finally(() => { site.inFlight = null; });
  return site.inFlight;
}

async function siteData() {
  if (!site.at) await Promise.race([refreshSiteData(), new Promise(r => setTimeout(r, DATA_WAIT_MS))]);
  else if (Date.now() - site.at > DATA_TTL_MS) refreshSiteData();
  return site;
}

// ---------- Structured data: real records only, nothing assumed ----------
function organizationLd(company) {
  const c = company || {};
  const base = SITE();
  const org = {
    '@type': 'Organization',
    '@id': `${base}/#organization`,
    name: isReal(c.company_name) ? c.company_name : COMPANY,
    url: `${base}/`,
    logo: `${base}/assets/images/shereboy-tech-logo-600.jpg`,
    image: `${base}/assets/og-cover.jpg`
  };
  if (isReal(c.description)) org.description = clip(c.description, 300);
  const email = isReal(c.email) ? c.email.replace(/^mailto:/i, '').trim() : '';
  if (email) org.email = email;
  if (isReal(c.phone)) org.telephone = c.phone.replace(/^tel:/i, '').trim();
  if (isReal(c.address)) org.address = { '@type': 'PostalAddress', streetAddress: c.address.trim(), addressCountry: 'NG' };
  if (isReal(c.cac_number)) org.identifier = { '@type': 'PropertyValue', propertyID: 'CAC RC', value: c.cac_number.trim() };
  if (isReal(c.ceo_name)) org.founder = { '@type': 'Person', name: c.ceo_name.trim() };
  const social = [c.instagram_url, c.tiktok_url, c.youtube_url].filter(isWebUrl).map(u => u.trim());
  if (social.length) org.sameAs = social;
  return org;
}

const websiteLd = () => ({
  '@type': 'WebSite',
  '@id': `${SITE()}/#website`,
  name: COMPANY,
  url: `${SITE()}/`,
  publisher: { '@id': `${SITE()}/#organization` }
});

function breadcrumbLd(trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: `${SITE()}${t.path}` }))
  };
}

function servicesLd(services) {
  return services.map(s => ({
    '@type': 'Service',
    name: s.title,
    ...(s.description ? { description: clip(s.description, 300) } : {}),
    provider: { '@id': `${SITE()}/#organization` }
  }));
}

function blogListLd(articles) {
  return {
    '@type': 'ItemList',
    name: 'Insights, News & Ideas from SHEREBOY BLOG',
    itemListElement: articles.map((a, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'BlogPosting',
        headline: a.title,
        url: a.canonicalUrl || a.url,
        datePublished: a.publishedAt,
        dateModified: a.updatedAt,
        ...(a.image ? { image: a.image.url } : {}),
        ...(a.author ? { author: { '@type': 'Person', name: a.author.name } } : {}),
        publisher: { '@type': 'Organization', name: 'SHEREBOY BLOG' }
      }
    }))
  };
}

// ---------- Server-rendered markup ----------
function serviceCards(services) {
  return services.map((s, i) => {
    const benefits = Array.isArray(s.benefits) ? s.benefits.filter(Boolean) : [];
    return `<article class="service ${services.length % 2 === 1 && i === 0 ? 'service--wide' : ''}">
            <span class="service__icon">${icon('code')}</span>
            <span class="service__num">${String(i + 1).padStart(2, '0')}</span>
            <h3>${esc(s.title)}</h3>
            <p class="service__desc">${esc(s.description)}</p>
            ${benefits.length ? `<ul class="service__benefits">${benefits.map(b => `<li>${icon('check')}<span>${esc(b)}</span></li>`).join('')}</ul>` : ''}
          </article>`;
  }).join('');
}

function projectCards(projects) {
  return projects.map(p => `<article class="project">
            <div class="project__body">
              <p class="project__cat">${esc(p.category || 'Project')}</p>
              <h3 class="project__title"><a href="/projects/${esc(p.id)}">${esc(p.title)}</a></h3>
              <p class="project__desc">${esc(String(p.description || '').split('\n').filter(Boolean)[0] || '')}</p>
            </div>
          </article>`).join('');
}

// Connected content: summaries that link to the original article or product page.
// The full content stays on SHEREBOY BLOG and SHEREBOY AFFILIATE CONCEPT, so nothing is duplicated here.
function articleCards(articles) {
  return articles.slice(0, 7).map(a => `<article class="blog-card">
            <div class="blog-card__body">
              ${a.category ? `<span class="blog-card__cat">${esc(a.category.name)}</span>` : ''}
              <h3 class="blog-card__title"><a href="${esc(a.canonicalUrl || a.url)}">${esc(a.title)}</a></h3>
              ${a.excerpt ? `<p class="blog-card__excerpt">${esc(a.excerpt)}</p>` : ''}
            </div>
          </article>`).join('');
}

function productCards(products) {
  return products.slice(0, 12).filter(p => p.url).map((p) => {
    const rel = p.urlType === 'partner-store' ? 'noopener sponsored' : 'noopener';
    return `<article class="product">
            <div class="product__body">
              ${p.category ? `<span class="product__cat">${esc(p.category.name)}</span>` : ''}
              <h3 class="product__name"><a href="${esc(p.url)}" target="_blank" rel="${rel}">${esc(p.name)}</a></h3>
              ${p.description ? `<p class="product__desc">${esc(p.description)}</p>` : ''}
            </div>
          </article>`;
  }).join('');
}

function paragraphs(text) {
  return String(text || '').split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');
}

function breadcrumbsHtml(trail) {
  return `<nav class="crumbs container" aria-label="Breadcrumb"><ol>${trail.map((t, i) => (i === trail.length - 1
    ? `<li aria-current="page">${esc(t.name)}</li>`
    : `<li><a href="${esc(t.path)}">${esc(t.name)}</a></li>`)).join('')}</ol></nav>`;
}

function projectDetail(p) {
  const live = isWebUrl(p.live_url) ? p.live_url.trim() : '';
  const repo = isWebUrl(p.github_url) ? p.github_url.trim() : '';
  const tech = Array.isArray(p.technologies) ? p.technologies.filter(Boolean) : [];
  const image = isWebUrl(p.image_url) ? p.image_url.trim() : '';
  return `<section class="section project-page" aria-labelledby="projectTitle">
      <div class="container project-page__inner">
        <div class="project-page__text">
          <p class="project__cat">${esc(p.category || 'Project')}</p>
          <h1 class="project-page__title" id="projectTitle">${esc(p.title)}</h1>
          <div class="project-page__desc">${paragraphs(p.description)}</div>
          ${tech.length ? `<div><h2 class="sub-title">Technologies used</h2><div class="chips">${tech.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div></div>` : ''}
          <div class="pd__actions">
            ${live && p.preview_enabled !== false ? `<button type="button" class="btn btn--primary" data-preview-project="${esc(p.id)}">${icon('eye')}Live Preview</button>` : ''}
            ${live ? `<a class="btn btn--ghost" href="${esc(live)}" target="_blank" rel="noopener">Visit Website ${icon('external')}</a>` : ''}
            ${repo ? `<a class="btn btn--ghost" href="${esc(repo)}" target="_blank" rel="noopener">${icon('github')}View Source</a>` : ''}
            <a class="btn btn--ghost" href="/contact" data-start-project>Start a similar project</a>
          </div>
        </div>
        ${image ? `<figure class="project-page__media"><img src="${esc(image)}" alt="${esc(`${p.title} screenshot`)}" width="1280" height="800" decoding="async"></figure>` : ''}
      </div>
    </section>`;
}

const NOT_FOUND = `<section class="section not-found" aria-labelledby="notFoundTitle">
      <div class="container not-found__inner">
        <p class="eyebrow">Error 404</p>
        <h1 class="section-title" id="notFoundTitle">We couldn't find that page.</h1>
        <p class="section-lede">The address may be mistyped, or the page may have moved. These links will get you back on track.</p>
        <div class="hero__actions">
          <a class="btn btn--primary btn--lg" href="/">Back to Home</a>
          <a class="btn btn--ghost btn--lg" href="/projects">See Our Projects</a>
          <a class="btn btn--ghost btn--lg" href="/contact">Contact Us</a>
        </div>
      </div>
    </section>`;

// ---------- Shell rendering ----------
function setAttr(html, re, value) { return html.replace(re, (m, a, b) => `${a}${value}${b}`); }
function setInner(html, id, inner) {
  const re = new RegExp(`(<(div|p|ol)\\b[^>]*\\bid="${id}"[^>]*>)[\\s\\S]*?(</\\2>)`);
  return html.replace(re, (m, open, tag, close) => `${open}${inner}${close}`);
}

function renderShell(pageKey, { title, description, url, image, ogType = 'website', ld = [], company, services, projects, top = '', robots = '' }) {
  let html = indexHtml();
  // Keep only this page's sections
  html = html.replace(/<!-- page:([\w,]+) -->([\s\S]*?)<!-- \/page -->/g, (m, pages, inner) => (pages.split(',').includes(pageKey) ? inner : ''));

  const t = esc(title);
  const d = esc(description);
  const u = esc(url);
  html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${t}</title>`);
  html = setAttr(html, /(<meta name="description"\s+content=")[^"]*(")/, d);
  html = setAttr(html, /(<link rel="canonical" href=")[^"]*(")/, u);
  html = setAttr(html, /(<meta property="og:title" content=")[^"]*(")/, t);
  html = setAttr(html, /(<meta property="og:description"\s+content=")[^"]*(")/, d);
  html = setAttr(html, /(<meta property="og:url" content=")[^"]*(")/, u);
  html = setAttr(html, /(<meta name="twitter:title" content=")[^"]*(")/, t);
  html = setAttr(html, /(<meta name="twitter:description" content=")[^"]*(")/, d);
  html = setAttr(html, /(<meta property="og:type" content=")[^"]*(")/, ogType);
  if (image && /^https:\/\//.test(image)) {
    html = setAttr(html, /(<meta property="og:image" content=")[^"]*(")/, esc(image));
    html = setAttr(html, /(<meta name="twitter:image" content=")[^"]*(")/, esc(image));
    html = html.replace(/\s*<meta property="og:image:(width|height|alt)"[^>]*>/g, '');
  }

  // Google Search Console verification, only when the owner has configured a real value
  const verification = String(process.env.GOOGLE_SITE_VERIFICATION || '').trim();
  const extraHead = [
    /^[\w-]{10,120}$/.test(verification) ? `<meta name="google-site-verification" content="${esc(verification)}">` : '',
    robots ? `<meta name="robots" content="${esc(robots)}">` : ''
  ].filter(Boolean).join('\n  ');
  const graph = ld.length ? `<script type="application/ld+json">${jsonLd({ '@context': 'https://schema.org', '@graph': ld })}</script>` : '';
  html = html.replace('<!-- seo:head -->', () => [extraHead, graph].filter(Boolean).join('\n  '));

  html = html.replace('<body>', () => `<body data-page="${esc(pageKey)}">`);
  html = html.replace('<!-- seo:top -->', () => top);

  // The page's main heading becomes its single <h1>
  const heading = PAGES[pageKey] && PAGES[pageKey].heading;
  if (heading) {
    const re = new RegExp(`<h2(\\s[^>]*\\bid="${heading}"[^>]*)>([\\s\\S]*?)</h2>`);
    html = html.replace(re, (m, attrs, inner) => `<h1${attrs}>${inner}</h1>`);
  }
  // Mark the current navigation link
  if (PAGES[pageKey] && pageKey !== 'home') {
    const current = PAGES[pageKey].path;
    html = html.replace(new RegExp(`(<a href="${current}")( data-nav="[\\w-]+")`, 'g'), (m, a, b) => `${a}${b} class="is-active" aria-current="page"`);
  }

  // Real content, so it is readable before and without JavaScript
  if (services && services.length) {
    html = setInner(html, 'servicesList', serviceCards(services));
    html = setInner(html, 'footerServices', services.slice(0, 5).map(s => `<a href="/services">${esc(s.title)}</a>`).join(''));
  }
  if (projects && projects.length) html = setInner(html, 'workGrid', projectCards(projects));
  if (pageKey === 'home') {
    const articles = blogFeed.cachedArticles();
    if (articles.length) html = setInner(html, 'blogFeed', articleCards(articles));
  }
  if (pageKey === 'affiliate') {
    const products = affiliateFeed.cachedProducts();
    if (products.length) html = setInner(html, 'affGrid', productCards(products));
  }
  if (company) {
    if (isReal(company.description)) html = setInner(html, 'aboutDescription', paragraphs(company.description));
    if (isReal(company.mission)) html = setInner(html, 'aboutMission', esc(company.mission));
    if (isReal(company.vision)) html = setInner(html, 'aboutVision', esc(company.vision));
  }
  return html;
}

const send = (res, html, status = 200) => {
  res.status(status).set('Cache-Control', 'no-cache').type('html').send(html);
};

// ---------- Routes ----------
function staticPage(pageKey) {
  return async (req, res) => {
    const def = PAGES[pageKey];
    const { company, services, projects } = await siteData();
    const url = `${SITE()}${def.path === '/' ? '/' : def.path}`;
    const ld = [organizationLd(company), websiteLd()];
    let top = '';
    if (pageKey !== 'home') {
      const trail = [{ name: 'Home', path: '/' }, { name: def.crumb, path: def.path }];
      ld.push(breadcrumbLd(trail));
      top = breadcrumbsHtml(trail);
    }
    if (pageKey === 'home' || pageKey === 'services') ld.push(...servicesLd(services));
    if (pageKey === 'home') {
      const articles = blogFeed.cachedArticles();
      if (articles.length) ld.push(blogListLd(articles));
    }
    send(res, renderShell(pageKey, { title: def.title, description: def.description, url, ld, company, services, projects, top }));
  };
}

async function notFound(req, res) {
  const { company, services } = await siteData();
  send(res, renderShell('notfound', {
    title: `Page Not Found | ${COMPANY}`,
    description: `The page you were looking for could not be found on the ${COMPANY} website.`,
    url: `${SITE()}${req.path.replace(/[^\w/.-]/g, '')}`,
    company, services, top: NOT_FOUND, robots: 'noindex'
  }), 404);
}

async function projectPage(req, res) {
  if (!UUID_RE.test(req.params.id)) return notFound(req, res);
  let project = null;
  try {
    const { data, error } = await supabase.from('projects').select('*').eq('id', req.params.id).eq('published', true).maybeSingle();
    if (error) throw new Error(error.message);
    project = data;
  } catch (err) {
    // A database problem is not a missing page: search engines should retry rather than drop the URL
    errorLog.record('seo', err.message, { method: req.method, path: req.path });
    return res.status(503).set('Retry-After', '60').type('text/plain').send('This page is temporarily unavailable. Please try again shortly.');
  }
  if (!project) return notFound(req, res);

  const { company, services, projects } = await siteData();
  const url = `${SITE()}/projects/${project.id}`;
  const trail = [{ name: 'Home', path: '/' }, { name: 'Projects', path: '/projects' }, { name: project.title, path: `/projects/${project.id}` }];
  const work = {
    '@type': 'CreativeWork',
    name: project.title,
    url,
    creator: { '@id': `${SITE()}/#organization` },
    ...(project.description ? { description: clip(project.description, 300) } : {}),
    ...(isWebUrl(project.image_url) ? { image: project.image_url.trim() } : {})
  };
  send(res, renderShell('project', {
    title: `${clip(project.title, 60)} | ${COMPANY}`,
    description: clip(project.description || `${project.category || 'Project'} designed and built by ${COMPANY}.`, 160),
    url,
    image: project.image_url,
    ogType: 'article',
    ld: [organizationLd(company), websiteLd(), breadcrumbLd(trail), work],
    company,
    services,
    projects: projects.filter(p => p.id !== project.id),
    top: `${breadcrumbsHtml(trail)}${projectDetail(project)}`
  }));
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const validDay = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };
const newest = (...dates) => dates.flat().map(validDay).filter(Boolean).sort().pop() || null;

async function sitemapEntries() {
  const [company, services, projects] = await Promise.all([
    supabase.from('company_settings').select('updated_at').eq('id', 1).maybeSingle(),
    supabase.from('services').select('updated_at').eq('published', true),
    supabase.from('projects').select('id, updated_at').eq('published', true)
  ]);
  if (projects.error) errorLog.record('seo', 'Sitemap could not read projects');
  const companyDay = company.data ? company.data.updated_at : null;
  const serviceDays = (services.data || []).map(s => s.updated_at);
  const projectRows = projects.data || [];
  const projectDays = projectRows.map(p => p.updated_at);
  const base = SITE();
  return [
    // lastmod is left out where there is no real change date to report
    { loc: `${base}/`, lastmod: newest(companyDay, serviceDays, projectDays) },
    { loc: `${base}/about`, lastmod: newest(companyDay) },
    { loc: `${base}/services`, lastmod: newest(serviceDays) },
    { loc: `${base}/projects`, lastmod: newest(projectDays) },
    { loc: `${base}/contact`, lastmod: newest(companyDay) },
    { loc: `${base}/affiliate-products`, lastmod: null },
    ...projectRows.map(p => ({ loc: `${base}/projects/${p.id}`, lastmod: newest(p.updated_at) }))
  ];
}

async function sitemap(req, res) {
  const entries = await sitemapEntries();
  const body = entries.map(e => `<url><loc>${xml(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`).join('\n  ');
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${body}\n</urlset>\n`);
}

const robotsText = () => `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${SITE()}/sitemap.xml\n`;
function robots(req, res) {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').send(robotsText());
}

/** Search-engine configuration summary for the admin System page. */
async function status() {
  const entries = await sitemapEntries().catch(() => []);
  const verification = String(process.env.GOOGLE_SITE_VERIFICATION || '').trim();
  return {
    siteUrl: SITE(),
    sitemapUrl: `${SITE()}/sitemap.xml`,
    robotsUrl: `${SITE()}/robots.txt`,
    sitemapUrlCount: entries.length,
    sitemapLatestChange: newest(entries.map(e => e.lastmod).filter(Boolean)),
    robots: robotsText(),
    verificationConfigured: /^[\w-]{10,120}$/.test(verification),
    pages: Object.values(PAGES).map(p => ({ path: p.path, title: p.title, description: p.description }))
  };
}

module.exports = {
  staticPage, notFound, projectPage, sitemap, robots, status, refreshSiteData, PAGES
};
