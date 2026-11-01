// test/site.test.js — run with: npm test
// Starts the real server in production mode against a throw-away in-memory
// database stand-in on a local port. It never contacts Supabase or the live site.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 10987;
const DB_PORT = 10988;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const TABLES = {
  company_settings: [{ id: 1, company_name: 'SHEREBOY TECH LTD', description: 'Test company description.', mission: 'Test mission.', vision: 'Test vision.', email: 'owner@example.com', cac_number: '123', updated_at: '2026-10-01T00:00:00Z' }],
  services: [{ id: 's1', title: 'Website Development', description: 'Test service.', published: true, display_order: 1, updated_at: '2026-10-02T00:00:00Z' }],
  projects: [{ id: PROJECT_ID, title: 'Test $& Project', description: 'A project with $1 and $` in its text.', category: 'Websites', published: true, updated_at: '2026-10-03T00:00:00Z', live_url: 'https://example.com', technologies: ['Node'] }]
};

// Answers just enough of Supabase's REST API for read-only public pages
function fakeDatabase(req, res) {
  const url = new URL(req.url, 'http://x');
  const rows = TABLES[url.pathname.replace('/rest/v1/', '')] || [];
  const idFilter = url.searchParams.get('id');
  const list = idFilter ? rows.filter(r => `eq.${r.id}` === idFilter) : rows;
  const single = /vnd\.pgrst\.object/.test(req.headers.accept || '');
  res.setHeader('Content-Type', 'application/json');
  if (single && !list.length) { res.statusCode = 406; return res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows' })); }
  res.end(JSON.stringify(single ? list[0] : list));
}

let db; let server;
before(async () => {
  db = http.createServer(fakeDatabase).listen(DB_PORT, '127.0.0.1');
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(PORT), SESSION_SECRET: 'x'.repeat(48),
      SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`, SUPABASE_SERVICE_ROLE_KEY: 'test-key',
      ADMIN_USERNAME: 'test', ADMIN_PASSWORD_HASH: '$2a$12$abcdefghijklmnopqrstuuJ5s3b8kqvJ8mBvQYkq1vQe0p5QnO3iW',
      // Nothing listens here: the connected services are "asleep" throughout
      BLOG_API_BASE_URL: 'http://127.0.0.1:9', AFFILIATE_API_BASE_URL: 'http://127.0.0.1:9',
      SERVICE_WAKE_WINDOW_SECONDS: '3', SERVICE_BACKOFF_BASE_MS: '200', BLOG_FETCH_TIMEOUT_MS: '300', AFFILIATE_FETCH_TIMEOUT_MS: '300',
      GOOGLE_SITE_VERIFICATION: 'test-verification-value'
    },
    stdio: 'ignore'
  });
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`${BASE}/robots.txt`); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('Server did not start');
});
after(() => { server?.kill(); db?.close(); db?.closeAllConnections?.(); });

const page = async (p, opts) => { const r = await fetch(BASE + p, { redirect: 'manual', ...opts }); return { r, text: await r.text() }; };

for (const [p, title] of [
  ['/', 'SHEREBOY TECH LTD | Software Development &amp; Digital Solutions'],
  ['/about', 'About SHEREBOY TECH LTD | Our Company and Vision'],
  ['/services', 'Software Development Services | SHEREBOY TECH LTD'],
  ['/projects', 'Our Projects | SHEREBOY TECH LTD'],
  ['/affiliate-products', 'Affiliate Products | SHEREBOY TECH LTD']
]) {
  test(`${p} has its own title, one h1 and a canonical address`, async () => {
    const { r, text } = await page(p);
    assert.equal(r.status, 200);
    assert.ok(text.includes(`<title>${title}</title>`));
    assert.equal((text.match(/<h1\b/g) || []).length, 1);
    assert.ok(text.includes(`<link rel="canonical" href="https://shereboytechltd.site${p}">`));
    assert.ok(!/<!-- (page|seo):/.test(text));
    assert.ok(text.includes('<meta name="google-site-verification" content="test-verification-value">'));
  });
}

test('stored text cannot break a page through replacement patterns', async () => {
  const { r, text } = await page(`/projects/${PROJECT_ID}`);
  assert.equal(r.status, 200);
  assert.ok(text.includes('Test $&amp; Project'));
  assert.ok(text.includes('A project with $1 and $` in its text.'));
});

test('structured data parses and holds only supplied facts', async () => {
  const { text } = await page('/services');
  const graph = JSON.parse(text.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1])['@graph'];
  const types = graph.map(n => n['@type']);
  for (const t of ['Organization', 'WebSite', 'BreadcrumbList', 'Service']) assert.ok(types.includes(t), t);
  const org = graph.find(n => n['@type'] === 'Organization');
  assert.equal(org.email, 'owner@example.com');
  assert.equal(org.telephone, undefined);
  assert.equal(org.aggregateRating, undefined);
});

test('unknown addresses are real 404s', async () => {
  for (const p of ['/nope', '/projects/not-a-uuid', '/projects/00000000-0000-4000-8000-000000000000']) {
    const { r, text } = await page(p);
    assert.equal(r.status, 404, p);
    assert.ok(text.includes('name="robots" content="noindex"'), p);
  }
  assert.equal((await page('/missing.png')).r.status, 404);
  assert.equal((await page('/api/nope')).r.status, 404);
});

test('duplicate addresses redirect', async () => {
  assert.equal((await page('/about/')).r.headers.get('location'), '/about');
  assert.equal((await page('/index.html')).r.headers.get('location'), '/');
});

test('sitemap is well formed, lists only public pages and has real dates', async () => {
  const { r, text } = await page('/sitemap.xml');
  assert.match(r.headers.get('content-type'), /xml/);
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  const locs = [...text.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(locs, ['/', '/about', '/services', '/projects', '/contact', '/affiliate-products', `/projects/${PROJECT_ID}`].map(p => `https://shereboytechltd.site${p}`));
  assert.ok(text.includes(`/projects/${PROJECT_ID}</loc><lastmod>2026-10-03</lastmod>`));
  assert.ok(!/admin|\/api/.test(text));
});

test('robots.txt allows public pages, blocks private areas and names the sitemap', async () => {
  const { text } = await page('/robots.txt');
  assert.ok(text.includes('Allow: /'));
  assert.ok(text.includes('Disallow: /admin'));
  assert.ok(text.includes('Disallow: /api/'));
  assert.ok(text.includes('Sitemap: https://shereboytechltd.site/sitemap.xml'));
  assert.ok(!/css|js|images/i.test(text.replace('sitemap.xml', '')));
});

test('security headers are present', async () => {
  const { r } = await page('/');
  const h = r.headers;
  assert.match(h.get('strict-transport-security'), /max-age=31536000/);
  assert.match(h.get('permissions-policy'), /camera=\(\)/);
  assert.match(h.get('content-security-policy'), /script-src 'self'/);
  assert.match(h.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal((await page('/admin/')).r.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('private routes need a session', async () => {
  for (const p of ['/api/system/overview', '/api/system/previews', '/api/dashboard/stats', '/api/admin/users']) {
    assert.equal((await page(p)).r.status, 401, p);
  }
  const put = await page('/api/company', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(put.r.status, 401);
});

test('malformed and oversized requests are client errors without detail', async () => {
  const bad = await page('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(bad.r.status, 400);
  assert.ok(!/stack|SyntaxError/.test(bad.text));
  const big = await page('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(1100000) }) });
  assert.equal(big.r.status, 413);
});

test('pages answer quickly while connected services are asleep, and feeds never hang', async () => {
  const start = Date.now();
  assert.equal((await page('/')).r.status, 200);
  const { r, text } = await page('/api/blog-feed');
  assert.ok(Date.now() - start < 4000, 'page and feed responded promptly');
  assert.equal(r.status, 200);
  assert.ok(['waking', 'unavailable'].includes(JSON.parse(text).status));
});
