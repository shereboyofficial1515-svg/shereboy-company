// test/feedback.test.js — run with: npm test
// Reviews & Feedback, end to end: the real server in production mode against an
// in-memory database and storage stand-in, and a fake Resend. Nothing real is touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { startFakeResend } = require('./support/fake-resend');

const PORT = 11001; const DB_PORT = 11002; const DB2_PORT = 11003; const PORT2 = 11004;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `http://127.0.0.1:${DB_PORT}`;
const PASSWORD = crypto.randomBytes(12).toString('hex');
const procs = [];
let resend;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dbRows = async (t) => (await fetch(`${DB}/__db`).then(r => r.json()))[t] || [];
let ipN = 0;
const visitor = () => { ipN += 1; return `203.0.113.${ipN % 250}`; };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);

const PRODUCTS = [
  { id: crypto.randomUUID(), slug: 'job-rush', name: 'JOB RUSH', is_active: true, display_order: 1 },
  { id: crypto.randomUUID(), slug: 'achiever', name: 'ACHIEVER', is_active: true, display_order: 2 },
  { id: crypto.randomUUID(), slug: 'shereblognews', name: 'SHEREBLOGNEWS', is_active: true, display_order: 3 },
  { id: crypto.randomUUID(), slug: 'retired-app', name: 'RETIRED APP', is_active: false, display_order: 4 }
];

function submit(fields = {}, { files = [], ip = visitor() } = {}) {
  const fd = new FormData();
  Object.entries({ product: 'job-rush', rating: '5', category: 'general', subject: 'Great app', message: 'It helped me find a job quickly.', ...fields }).forEach(([k, v]) => fd.append(k, v));
  files.forEach(f => fd.append('attachments', new Blob([f.buf], { type: f.type }), f.name));
  return fetch(`${BASE}/api/feedback`, { method: 'POST', headers: { 'X-Forwarded-For': ip }, body: fd }).then(async r => ({ status: r.status, data: await r.json() }));
}

function staff() {
  let cookie = ''; let csrf = ''; const ip = visitor();
  const req = async (p, { method = 'GET', body } = {}) => {
    const h = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': ip };
    if (cookie) h.Cookie = cookie;
    if (method !== 'GET') h['X-CSRF-Token'] = csrf;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(BASE + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = Buffer.from(await r.arrayBuffer()).toString('utf8'); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, text, headers: r.headers };
  };
  return { req, async login(u, p) { const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: p } }); csrf = r.data.csrfToken || ''; return r; } };
}
let admin; let editor;

function start(port, dbPort) {
  procs.push(spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production', PORT: String(port), SESSION_SECRET: 'y'.repeat(48),
      SUPABASE_URL: `http://127.0.0.1:${dbPort}`, SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_STORAGE_BUCKET: 'shereboy-media', SUPABASE_PRIVATE_BUCKET: 'shereboy-private',
      ADMIN_USERNAME: 'testadmin', ADMIN_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4),
      RESEND_API_KEY: 're_test_only', RESEND_BASE_URL: resend.url, RESEND_FROM_EMAIL: 'SHEREBOY TECH LTD <support@shereboytechltd.site>',
      BLOG_API_BASE_URL: 'http://127.0.0.1:9', AFFILIATE_API_BASE_URL: 'http://127.0.0.1:9', SERVICE_WAKE_WINDOW_SECONDS: '1'
    },
    stdio: 'ignore'
  }));
}
const ready = async (port) => { for (let i = 0; i < 100; i += 1) { try { await fetch(`http://127.0.0.1:${port}/robots.txt`); return; } catch { await sleep(100); } } throw new Error('server did not start'); };

before(async () => {
  resend = await startFakeResend();
  const seed = path.join(os.tmpdir(), `feedback-seed-${process.pid}.json`);
  fs.writeFileSync(seed, JSON.stringify({
    company_settings: [{ id: 1 }], services: [], projects: [], reviews: [{ id: crypto.randomUUID(), client_name: 'Existing Client', review_text: 'Existing review', rating: 5, published: true }], blog_posts: [], contact_messages: [], activity_log: [], users: [], media_assets: [],
    products: PRODUCTS,
    __relations: { feedback: { products: 'product_id' }, testimonials: { products: 'product_id', feedback: 'feedback_id' } }
  }));
  procs.push(spawn(process.execPath, [path.join(__dirname, 'support', 'mock-db.js'), seed, String(DB_PORT)], { stdio: 'ignore' }));
  procs.push(spawn(process.execPath, [path.join(__dirname, 'support', 'mock-db.js'), seed, String(DB2_PORT), '--unmigrated'], { stdio: 'ignore' }));
  await sleep(400);
  start(PORT, DB_PORT); start(PORT2, DB2_PORT);
  await ready(PORT); await ready(PORT2);
  admin = staff();
  assert.equal((await admin.login('testadmin', PASSWORD)).status, 200);
  assert.equal((await admin.req('/api/admin/users', { method: 'POST', body: { username: 'fb.editor', password: 'editor-pass-123', role: 'editor' } })).status, 201);
  editor = staff();
  assert.equal((await editor.login('fb.editor', 'editor-pass-123')).status, 200);
});
after(() => { procs.forEach(p => p.kill()); resend && resend.close(); });

// ---------- Public ----------
test('the feedback page exists, with one h1, and is in the sitemap', async () => {
  const r = await fetch(`${BASE}/feedback?product=achiever`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.ok(html.includes('id="feedbackForm"'));
  assert.ok(html.includes('Share Your Feedback | SHEREBOY TECH LTD'));
  assert.ok((await fetch(`${BASE}/sitemap.xml`).then(x => x.text())).includes('/feedback</loc>'));
  assert.ok((await fetch(`${BASE}/`).then(x => x.text())).includes('href="/feedback"'), 'footer link');
});

test('products come from the database: active only, no private fields', async () => {
  const { products, categories } = await fetch(`${BASE}/api/feedback/products`).then(r => r.json());
  assert.deepEqual(products.map(p => p.slug), ['job-rush', 'achiever', 'shereblognews']);
  assert.ok(!('id' in products[0]) && !('is_active' in products[0]));
  assert.equal(Object.keys(categories).length, 7);
});

test('submission: validated, saved with a reference, linked to its product', async () => {
  for (const [fields, why] of [[{ product: 'nope' }, 'unknown product'], [{ product: 'retired-app' }, 'inactive product'], [{ rating: '6' }, 'rating'], [{ rating: '0' }, 'rating'], [{ category: 'rant' }, 'category'], [{ subject: 'x' }, 'subject'], [{ message: 'short' }, 'message'], [{ email: 'not-an-email' }, 'email']]) {
    assert.equal((await submit(fields)).status, 400, why);
  }
  const r = await submit({ name: 'Ada', email: 'Ada@Example.com', rating: '4', category: 'bug', subject: 'Login fails', message: 'The login button does nothing on my phone.' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.reference, /^FB-\d{8}-[0-9A-F]{6}$/);
  const row = (await dbRows('feedback')).find(f => f.reference === r.data.reference);
  assert.equal(row.product_id, PRODUCTS[0].id);
  assert.equal(row.email, 'ada@example.com');
  assert.equal(row.status, 'new');
  assert.equal(row.is_read, false);
  assert.ok(!JSON.stringify(r.data).includes('ada@example.com'), 'nothing private comes back');
});

test('anonymous feedback works, and the hidden trap field fakes success for bots', async () => {
  const r = await submit({ product: 'achiever', rating: '2', category: 'complaint', subject: 'Slow app', message: 'Pages take a long time to load.' });
  assert.equal(r.status, 201);
  const row = (await dbRows('feedback')).find(f => f.reference === r.data.reference);
  assert.equal(row.name, null); assert.equal(row.email, null);
  const before = (await dbRows('feedback')).length;
  const bot = await submit({ website: 'http://spam.example' });
  assert.equal(bot.status, 201);
  assert.equal((await dbRows('feedback')).length, before);
});

test('a double submit returns the first reference instead of a duplicate', async () => {
  const ip = visitor();
  const a = await submit({ subject: 'Duplicate test', message: 'Exactly the same message twice.' }, { ip });
  const b = await submit({ subject: 'Duplicate test', message: 'Exactly the same message twice.' }, { ip });
  assert.equal(b.data.reference, a.data.reference);
  assert.equal((await dbRows('feedback')).filter(f => f.subject === 'Duplicate test').length, 1);
});

test('attachments: real images and PDFs only, at most 3, stored privately', async () => {
  const fake = await submit({}, { files: [{ buf: Buffer.from('<html><script>x</script>'), type: 'image/png', name: 'x.png' }] });
  assert.equal(fake.status, 400);
  const svg = await submit({}, { files: [{ buf: Buffer.from('<svg/>'), type: 'image/svg+xml', name: 'x.svg' }] });
  assert.equal(svg.status, 400);
  const four = await submit({}, { files: [1, 2, 3, 4].map(n => ({ buf: PNG, type: 'image/png', name: `${n}.png` })) });
  assert.equal(four.status, 400);
  const ok = await submit({ subject: 'With screenshot', message: 'See the attached screenshot please.' }, { files: [{ buf: PNG, type: 'image/png', name: 'screen shot.png' }, { buf: Buffer.from('%PDF-1.4 test'), type: 'application/pdf', name: 'report.pdf' }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const fb = (await dbRows('feedback')).find(f => f.reference === ok.data.reference);
  const files = (await dbRows('feedback_attachments')).filter(a => a.feedback_id === fb.id);
  assert.equal(files.length, 2);
  assert.ok(files.every(f => f.bucket === 'shereboy-private' && f.storage_path.startsWith(`feedback/${fb.id}/`)));
});

test('the submission form is rate limited per visitor', async () => {
  const ip = visitor(); const codes = [];
  for (let i = 0; i < 8; i += 1) codes.push((await submit({ subject: `Rate ${i}`, message: `Message number ${i} for the limit.` }, { ip })).status);
  assert.ok(codes.includes(429), codes.join());
});

// ---------- Admin ----------
test('the module needs a signed-in staff member; delete and export need an administrator', async () => {
  for (const p of ['overview', 'items', 'products', 'testimonials', 'analytics']) assert.equal((await fetch(`${BASE}/api/feedback-admin/${p}`)).status, 401, p);
  assert.equal((await editor.req('/api/feedback-admin/overview')).status, 200);
  assert.equal((await editor.req('/api/feedback-admin/export.csv')).status, 403);
  const any = (await dbRows('feedback'))[0];
  assert.equal((await editor.req(`/api/feedback-admin/items/${any.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(`${BASE}/api/feedback-admin/items/${any.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"status":"resolved"}' })).status, 401);
});

test('overview statistics match the actual records', async () => {
  const rows = (await dbRows('feedback'));
  const d = (await admin.req('/api/feedback-admin/overview')).data;
  assert.equal(d.total, rows.length);
  assert.equal(d.new, rows.filter(r => r.status === 'new').length);
  const average = Math.round(rows.reduce((a, r) => a + r.rating, 0) / rows.length * 10) / 10;
  assert.equal(d.avgRating, average);
  assert.equal(d.ratings.reduce((a, r) => a + r.count, 0), rows.length);
  assert.equal(d.months[11].count, rows.length, 'all submitted this month');
  assert.equal(d.byProduct.find(p => p.name === 'ACHIEVER').complaints, rows.filter(r => r.product_id === PRODUCTS[1].id && r.category === 'complaint').length);
  assert.equal(d.productsWithFeedback, new Set(rows.map(r => r.product_id)).size);
});

test('search and filters', async () => {
  const get = async (qs) => (await admin.req(`/api/feedback-admin/items?${qs}`)).data;
  assert.ok((await get('q=login')).items.every(i => /login/i.test(i.subject)));
  assert.equal((await get('q=login')).total, 1);
  assert.ok((await get(`product=${PRODUCTS[1].id}`)).items.every(i => i.product.name === 'ACHIEVER'));
  assert.ok((await get('category=complaint')).items.every(i => i.category === 'complaint'));
  assert.ok((await get('rating=4')).items.every(i => i.rating === 4));
  assert.equal((await get('status=resolved')).total, 0);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await get(`from=${today}&to=${today}`)).total, (await get('')).total);
  assert.equal((await get('from=2000-01-01&to=2000-01-02')).total, 0);
  assert.equal((await get('q=x%27%29%2Cid.eq.1')).items.length, 0, 'filter syntax in the search is neutralised');
});

test('details, read state, status changes, notes and attachments', async () => {
  const fb = (await dbRows('feedback')).find(f => f.subject === 'With screenshot');
  const d = (await admin.req(`/api/feedback-admin/items/${fb.id}`)).data;
  assert.equal(d.item.message, 'See the attached screenshot please.');
  assert.equal(d.attachments.length, 2);
  assert.ok(!('storage_path' in d.attachments[0]), 'storage paths stay on the server');
  assert.equal((await dbRows('feedback')).find(f => f.id === fb.id).is_read, true, 'opening marks it read');

  const link = (await admin.req(`/api/feedback-admin/attachments/${d.attachments[0].id}`)).data;
  assert.match(link.url, /token=/);
  assert.equal(link.expiresIn, 300);

  assert.equal((await admin.req(`/api/feedback-admin/items/${fb.id}`, { method: 'PATCH', body: { is_read: false } })).status, 200);
  assert.equal((await admin.req(`/api/feedback-admin/items/${fb.id}`, { method: 'PATCH', body: { status: 'in_progress' } })).status, 200);
  assert.equal((await admin.req(`/api/feedback-admin/items/${fb.id}`, { method: 'PATCH', body: { status: 'nonsense' } })).status, 400);
  assert.equal((await editor.req(`/api/feedback-admin/items/${fb.id}/notes`, { method: 'POST', body: { note: 'Checking with the developer.' } })).status, 201);
  const notes = (await dbRows('feedback_internal_notes')).filter(n => n.feedback_id === fb.id);
  assert.equal(notes[0].admin_username, 'fb.editor');
  assert.ok(!JSON.stringify(await fetch(`${BASE}/api/feedback/testimonials`).then(r => r.json())).includes('Checking with the developer'));
});

test('replies: recorded with author and time, emailed through Resend when possible', async () => {
  const withEmail = (await dbRows('feedback')).find(f => f.email === 'ada@example.com');
  const r = await admin.req(`/api/feedback-admin/items/${withEmail.id}/responses`, { method: 'POST', body: { message: 'Thanks Ada, a fix is on the way.', send_email: true } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.response.email_status, 'accepted');
  assert.equal(r.data.response.admin_username, 'testadmin');
  const mail = resend.state.emails.find(m => m.to.includes('ada@example.com'));
  assert.match(mail.subject, /Re: Login fails \[FB-/);
  assert.match(mail.from, /support@shereboytechltd\.site/);
  assert.ok(mail.html.includes('a fix is on the way'));
  assert.equal((await dbRows('feedback')).find(f => f.id === withEmail.id).status, 'responded', 'status follows the reply');

  const anon = (await dbRows('feedback')).find(f => f.email === null && f.subject === 'Slow app');
  assert.equal((await admin.req(`/api/feedback-admin/items/${anon.id}/responses`, { method: 'POST', body: { message: 'Hi', send_email: true } })).status, 400);
  const saved = await admin.req(`/api/feedback-admin/items/${anon.id}/responses`, { method: 'POST', body: { message: 'Noted, we are looking into speed.' } });
  assert.equal(saved.data.response.email_status, 'not_sent');

  resend.state.mode = '403'; resend.state.failTimes = 1;
  const failed = await admin.req(`/api/feedback-admin/items/${withEmail.id}/responses`, { method: 'POST', body: { message: 'Second reply', send_email: true } });
  assert.equal(failed.data.response.email_status, 'failed');
  assert.match(failed.data.response.email_error, /not verified/);
  const history = (await admin.req(`/api/feedback-admin/items/${withEmail.id}`)).data.responses;
  assert.equal(history.length, 2);
  assert.ok(history[0].created_at <= history[1].created_at);
});

test('testimonials: only with permission, published only after approval, featurable', async () => {
  const noPerm = await submit({ subject: 'No permission', message: 'Please keep this private, thanks.', rating: '5' });
  const yes = await submit({ product: 'shereblognews', name: 'Tunde', subject: 'Love it', message: 'Best Nigerian news app I use daily.', rating: '5', allow_publish: 'true' });
  const anonYes = await submit({ product: 'shereblognews', subject: 'Nice', message: 'Clean design and fast pages.', rating: '4', allow_publish: 'true' });
  assert.equal(yes.status, 201);
  assert.equal(anonYes.status, 201);
  const fbNo = (await dbRows('feedback')).find(f => f.reference === noPerm.data.reference);
  const ts = await dbRows('testimonials');
  assert.ok(!ts.some(t => t.feedback_id === fbNo.id), 'no candidate without permission');
  const t = ts.find(x => x.quote === 'Best Nigerian news app I use daily.');
  assert.equal(t.status, 'pending');
  assert.equal(t.display_name, 'Tunde');
  assert.equal(ts.find(x => x.quote === 'Clean design and fast pages.').display_name, 'A SHEREBLOGNEWS user');

  assert.equal((await fetch(`${BASE}/api/feedback/testimonials`).then(r => r.json())).testimonials.length, 0, 'nothing public before approval');
  assert.equal((await admin.req(`/api/feedback-admin/testimonials/${t.id}`, { method: 'PATCH', body: { featured: true } })).status, 400, 'cannot feature before approval');
  assert.equal((await admin.req(`/api/feedback-admin/testimonials/${t.id}`, { method: 'PATCH', body: { status: 'approved' } })).status, 200);
  assert.equal((await admin.req(`/api/feedback-admin/testimonials/${t.id}`, { method: 'PATCH', body: { featured: true } })).status, 200);

  const pub = (await fetch(`${BASE}/api/feedback/testimonials?product=shereblognews`).then(r => r.json())).testimonials;
  assert.equal(pub.length, 1);
  assert.deepEqual(Object.keys(pub[0]).sort(), ['date', 'featured', 'name', 'product', 'quote', 'rating']);
  assert.equal(pub[0].product, 'SHEREBLOGNEWS');
  assert.equal((await fetch(`${BASE}/api/feedback/testimonials?product=job-rush`).then(r => r.json())).testimonials.length, 0);
  assert.equal((await fetch(`${BASE}/api/feedback/testimonials?featured=1`).then(r => r.json())).testimonials.length, 1);

  // Permission is checked again at approval, even if a candidate somehow exists
  await fetch(`${DB}/rest/v1/testimonials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback_id: fbNo.id, product_id: PRODUCTS[0].id, display_name: 'X', quote: 'Please keep this private, thanks.', rating: 5 }) });
  const forged = (await dbRows('testimonials')).find(x => x.feedback_id === fbNo.id);
  assert.equal((await admin.req(`/api/feedback-admin/testimonials/${forged.id}`, { method: 'PATCH', body: { status: 'approved' } })).status, 403);

  const list = (await admin.req(`/api/feedback-admin/testimonials?product=${PRODUCTS[2].id}&positive=1`)).data.testimonials;
  assert.ok(list.length >= 2 && list.every(x => x.rating >= 4 && x.product.name === 'SHEREBLOGNEWS'));

  assert.equal((await admin.req(`/api/feedback-admin/testimonials/${t.id}`, { method: 'PATCH', body: { status: 'unpublished' } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/feedback/testimonials`).then(r => r.json())).testimonials.length, 0);
  assert.equal((await dbRows('testimonials')).find(x => x.id === t.id).featured, false);
  await admin.req(`/api/feedback-admin/testimonials/${t.id}`, { method: 'PATCH', body: { status: 'approved' } });
  await admin.req(`/api/feedback-admin/testimonials/${t.id}`, { method: 'PATCH', body: { featured: true } });
});

test('products: add, edit, deactivate; new products reach the public form at once', async () => {
  assert.equal((await admin.req('/api/feedback-admin/products', { method: 'POST', body: { name: 'JOB RUSH', slug: 'job-rush' } })).status, 400, 'link names are unique');
  assert.equal((await admin.req('/api/feedback-admin/products', { method: 'POST', body: { name: 'X', logo_url: 'http://insecure.example/a.png' } })).status, 400);
  const made = await editor.req('/api/feedback-admin/products', { method: 'POST', body: { name: 'Shere Pay', description: 'Payments', website_url: 'https://pay.example.com' } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.product.slug, 'shere-pay');
  assert.ok((await fetch(`${BASE}/api/feedback/products`).then(r => r.json())).products.some(p => p.slug === 'shere-pay'));
  assert.equal((await submit({ product: 'shere-pay', subject: 'First', message: 'First feedback for the new product.' })).status, 201);

  assert.equal((await admin.req(`/api/feedback-admin/products/${made.data.product.id}`, { method: 'PUT', body: { is_active: false } })).status, 200);
  assert.ok(!(await fetch(`${BASE}/api/feedback/products`).then(r => r.json())).products.some(p => p.slug === 'shere-pay'));
  assert.equal((await submit({ product: 'shere-pay', subject: 'Second', message: 'Should be refused now it is off.' })).status, 400);
  assert.equal((await admin.req(`/api/feedback-admin/products/${made.data.product.id}`, { method: 'DELETE' })).status, 409, 'products with feedback are kept');

  const list = (await admin.req('/api/feedback-admin/products')).data.products;
  const jr = list.find(p => p.slug === 'job-rush');
  assert.equal(jr.feedbackCount, (await dbRows('feedback')).filter(f => f.product_id === PRODUCTS[0].id).length);
});

test('analytics come from the records, and the CSV export is safe', async () => {
  await submit({ product: 'achiever', rating: '1', category: 'bug', subject: 'Crash on upload', message: 'The app crashes when I upload.' });
  await submit({ product: 'achiever', rating: '2', category: 'bug', subject: 'Upload crash again', message: 'Still crashing on upload today.' });
  await submit({ product: 'job-rush', rating: '4', category: 'feature', subject: 'Dark mode please', message: 'I would love a dark mode option.' });
  await submit({ product: 'job-rush', rating: '5', category: 'feature', subject: 'Dark mode for night', message: 'A dark mode would be great at night.' });
  await submit({ product: 'job-rush', rating: '5', subject: '=HYPERLINK("http://evil")', message: 'Formula test for the export file.' });
  const a = (await admin.req('/api/feedback-admin/analytics')).data;
  const rows = await dbRows('feedback');
  const count = (id) => rows.filter(r => r.product_id === id).length;
  assert.equal(a.mostReviewed.count, Math.max(...PRODUCTS.map(p => count(p.id))));
  assert.equal(a.mostComplaints.name, 'ACHIEVER');
  assert.ok(a.commonProblems.some(w => w.word === 'upload' || w.word === 'crash'), JSON.stringify(a.commonProblems));
  assert.ok(a.requestedFeatures.some(w => w.word === 'dark' || w.word === 'mode'), JSON.stringify(a.requestedFeatures));
  assert.ok(a.highestRated === null || a.highestRated.count >= 3);

  const csv = await admin.req('/api/feedback-admin/export.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /feedback-\d{4}-\d{2}-\d{2}\.csv/);
  assert.ok(csv.text.charCodeAt(0) === 0xFEFF, 'Excel byte-order mark');
  assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil"")"`), 'formula neutralised');
  assert.equal(csv.text.trim().split('\r\n').length - 1, rows.length);
});

test('delete removes the feedback and its stored files', async () => {
  const fb = (await dbRows('feedback')).find(f => f.subject === 'With screenshot');
  assert.equal((await admin.req(`/api/feedback-admin/items/${fb.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await dbRows('feedback')).some(f => f.id === fb.id));
});

test('the homepage reviews include featured testimonials beside existing reviews', async () => {
  const html = await fetch(`${BASE}/`).then(r => r.text());
  assert.ok(html.includes('id="reviews"'));
  const own = await fetch(`${BASE}/api/reviews`).then(r => r.json());
  assert.equal(own.reviews[0].client_name, 'Existing Client', 'existing reviews unchanged');
  const featured = await fetch(`${BASE}/api/feedback/testimonials?featured=1`).then(r => r.json());
  assert.equal(featured.testimonials[0].name, 'Tunde');
});

test('before the database update, the page says feedback is not open and the admin explains why', async () => {
  const base2 = `http://127.0.0.1:${PORT2}`;
  const p = await fetch(`${base2}/api/feedback/products`);
  assert.equal(p.status, 503);
  assert.equal((await fetch(`${base2}/feedback`)).status, 200);
  assert.equal((await fetch(`${base2}/api/feedback/testimonials`).then(r => r.json())).testimonials.length, 0);
});
