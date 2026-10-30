// server/seo.js
// Server-side SEO for the single-page site:
//  * /sitemap.xml — absolute URLs for the homepage, published projects and articles
//  * /projects/:id and /blog/:slug — the same app shell, but with that page's
//    <title>, description, canonical URL and Open Graph tags filled in, so search
//    engines and social networks see the right preview without running JS.
const fs = require('fs');
const path = require('path');
const supabase = require('./database');

const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');
const SITE = () => (process.env.SITE_URL || 'https://shereboytechltd.site').split(',')[0].trim().replace(/\/+$/, '');

let indexCache = null;
function indexHtml() {
  // Re-read in development so edits show up without a restart
  if (!indexCache || process.env.NODE_ENV !== 'production') indexCache = fs.readFileSync(INDEX_PATH, 'utf8');
  return indexCache;
}

const escAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

function withMeta({ title, description, url, image }) {
  let html = indexHtml();
  const t = escAttr(title);
  const d = escAttr(description);
  const u = escAttr(url);
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta name="description"\s+content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${u}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta property="og:description"\s+content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${u}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta property="og:type" content=")[^"]*(")/, '$1article$2');
  if (image && /^https:\/\//.test(image)) {
    html = html.replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${escAttr(image)}$2`)
      .replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${escAttr(image)}$2`)
      .replace(/\s*<meta property="og:image:(width|height|alt)"[^>]*>/g, '');
  }
  return html;
}

async function projectPage(req, res, next) {
  try {
    const { data } = await supabase.from('projects').select('id, title, description, image_url, category').eq('id', req.params.id).eq('published', true).maybeSingle();
    if (!data) return next();
    res.type('html').send(withMeta({
      title: `${data.title} — Project by SHEREBOY TECH LTD`,
      description: clip(data.description || `${data.category || 'Project'} designed and built by SHEREBOY TECH LTD.`, 160),
      url: `${SITE()}/projects/${data.id}`,
      image: data.image_url
    }));
  } catch { next(); }
}

async function blogPage(req, res, next) {
  try {
    const { data } = await supabase.from('blog_posts').select('slug, title, excerpt, featured_image_url').eq('slug', req.params.slug).eq('published', true).maybeSingle();
    if (!data) return next();
    res.type('html').send(withMeta({
      title: `${data.title} — SHEREBOY TECH LTD Insights`,
      description: clip(data.excerpt || data.title, 160),
      url: `${SITE()}/blog/${data.slug}`,
      image: data.featured_image_url
    }));
  } catch { next(); }
}

async function sitemap(req, res) {
  const [projects, posts] = await Promise.all([
    supabase.from('projects').select('id, updated_at').eq('published', true),
    supabase.from('blog_posts').select('slug, updated_at').eq('published', true)
  ]);
  const day = (d) => (d ? new Date(d) : new Date()).toISOString().slice(0, 10);
  const urls = [
    `<url><loc>${SITE()}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
    ...(projects.data || []).map(p => `<url><loc>${SITE()}/projects/${p.id}</loc><lastmod>${day(p.updated_at)}</lastmod><priority>0.7</priority></url>`),
    ...(posts.data || []).map(p => `<url><loc>${SITE()}/blog/${encodeURIComponent(p.slug)}</loc><lastmod>${day(p.updated_at)}</lastmod><priority>0.6</priority></url>`)
  ];
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${urls.join('\n  ')}\n</urlset>\n`);
}

function robots(req, res) {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\n\nSitemap: ${SITE()}/sitemap.xml\n`);
}

module.exports = { projectPage, blogPage, sitemap, robots };
