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
const { startFakeGemini } = require('./support/fake-gemini');

const PORT = 11001; const DB_PORT = 11002; const DB2_PORT = 11003; const PORT2 = 11004; const DB3_PORT = 11005; const PORT3 = 11006;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `http://127.0.0.1:${DB_PORT}`;
const PASSWORD = crypto.randomBytes(12).toString('hex');
const procs = [];
let resend; let gemini;
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
  Object.entries({ product: 'job-rush', rating: '5', category: 'general', subject: 'Great app', message: 'It helped me find a job quickly.', name: 'Test Customer', email: 'customer@example.com', ...fields }).forEach(([k, v]) => fd.append(k, v));
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
async function settle() {
  for (let i = 0; i < 100; i += 1) {
    const busy = (await dbRows('feedback')).some(r => r.email && !r.suspected_spam && (['not_required', 'pending'].includes(r.confirmation_status) || r.ai_status === 'pending'));
    if (!busy) return;
    await sleep(50);
  }
  throw new Error('background email/AI work did not finish');
}

function start(port, dbPort) {
  procs.push(spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production', PORT: String(port), SESSION_SECRET: 'y'.repeat(48),
      SUPABASE_URL: `http://127.0.0.1:${dbPort}`, SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_STORAGE_BUCKET: 'shereboy-media', SUPABASE_PRIVATE_BUCKET: 'shereboy-private',
      ADMIN_USERNAME: 'testadmin', ADMIN_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4),
      RESEND_API_KEY: 're_test_only', RESEND_BASE_URL: resend.url, RESEND_FROM_EMAIL: 'SHEREBOY TECH LTD <support@shereboytechltd.site>', FEEDBACK_INGEST_SECRET: 'test-ingest-secret', GEMINI_API_KEY: 'test-gemini-key', GEMINI_BASE_URL: gemini.url, GEMINI_MODEL: 'gemini-2.5-flash',
      BLOG_API_BASE_URL: 'http://127.0.0.1:9', AFFILIATE_API_BASE_URL: 'http://127.0.0.1:9', SERVICE_WAKE_WINDOW_SECONDS: '1'
    },
    stdio: 'ignore'
  }));
}
const ready = async (port) => { for (let i = 0; i < 100; i += 1) { try { await fetch(`http://127.0.0.1:${port}/robots.txt`); return; } catch { await sleep(100); } } throw new Error('server did not start'); };

before(async () => {
  resend = await startFakeResend();
  gemini = await startFakeGemini();
  const seed = path.join(os.tmpdir(), `feedback-seed-${process.pid}.json`);
  fs.writeFileSync(seed, JSON.stringify({
    company_settings: [{ id: 1 }], services: [], projects: [], reviews: [{ id: crypto.randomUUID(), client_name: 'Existing Client', review_text: 'Existing review', rating: 5, published: true }], blog_posts: [], contact_messages: [], activity_log: [], users: [], media_assets: [],
    products: PRODUCTS,
    __relations: { feedback: { products: 'product_id' }, testimonials: { products: 'product_id', feedback: 'feedback_id' }, feedback_emails: { feedback: 'feedback_id' }, feedback_ai_log: { feedback: 'feedback_id' } },
    feedback_ai_settings: [{ id: 1, auto_reply_enabled: false, require_approval: true, status_emails_enabled: true }]
  }));
  procs.push(spawn(process.execPath, [path.join(__dirname, 'support', 'mock-db.js'), seed, String(DB_PORT)], { stdio: 'ignore' }));
  procs.push(spawn(process.execPath, [path.join(__dirname, 'support', 'mock-db.js'), seed, String(DB2_PORT), '--unmigrated'], { stdio: 'ignore' }));
  procs.push(spawn(process.execPath, [path.join(__dirname, 'support', 'mock-db.js'), seed, String(DB3_PORT), '--before-comms'], { stdio: 'ignore' }));
  await sleep(400);
  start(PORT, DB_PORT); start(PORT2, DB2_PORT); start(PORT3, DB3_PORT);
  await ready(PORT); await ready(PORT2); await ready(PORT3);
  admin = staff();
  assert.equal((await admin.login('testadmin', PASSWORD)).status, 200);
  assert.equal((await admin.req('/api/admin/users', { method: 'POST', body: { username: 'fb.editor', password: 'editor-pass-123', role: 'editor' } })).status, 201);
  editor = staff();
  assert.equal((await editor.login('fb.editor', 'editor-pass-123')).status, 200);
});
after(() => { procs.forEach(p => p.kill()); resend && resend.close(); gemini && gemini.close(); });

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
  for (const [fields, why] of [[{ product: 'nope' }, 'unknown product'], [{ product: 'retired-app' }, 'inactive product'], [{ rating: '6' }, 'rating'], [{ rating: '0' }, 'rating'], [{ category: 'rant' }, 'category'], [{ subject: 'x' }, 'subject'], [{ message: 'short' }, 'message'], [{ email: 'not-an-email' }, 'email'], [{ email: '' }, 'email is required'], [{ name: '' }, 'name is required'], [{ name: 'A' }, 'full name']]) {
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

test('a name and a valid email are required', async () => {
  const none = await submit({ name: '', email: '' });
  assert.equal(none.status, 400);
  assert.ok(none.data.errors.includes('Enter your email address.') && none.data.errors.includes('Enter your full name.'));
  assert.match((await submit({ email: 'ada@@example' })).data.error, /valid email/);
});

test('the hidden trap field never loses real feedback: it is kept, flagged, and gets no email', async () => {
  const before = (await dbRows('feedback')).length;
  // Garbage from a bot: nothing worth keeping, and the bot cannot tell
  const junk = await submit({ website: 'http://spam.example', subject: 'x', message: 'y' });
  assert.equal(junk.status, 201);
  assert.equal((await dbRows('feedback')).length, before);
  // A real person whose browser autofilled the hidden field
  await settle();
  const sent = resend.state.emails.length;
  const real = await submit({ website: 'https://my-site.example', name: 'Autofill User', email: 'autofill@example.com', subject: 'Autofilled form', message: 'My browser filled in every field for me.', allow_publish: 'true' });
  assert.equal(real.status, 201);
  await sleep(300);
  const row = (await dbRows('feedback')).find(r => r.reference === real.data.reference);
  assert.ok(row, 'saved');
  assert.equal(row.suspected_spam, true);
  assert.equal(row.allow_publish, false, 'never published');
  assert.equal(resend.state.emails.length, sent, 'no confirmation email to an address a bot may have typed');
  const list = (await admin.req('/api/feedback-admin/items?q=Autofilled')).data.items;
  assert.equal(list.length, 1, 'shown in the dashboard');
  assert.equal(list[0].suspected_spam, true);
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
  const mail = resend.state.emails.find(m => m.to.includes('ada@example.com') && /^Re: /.test(m.subject));
  assert.match(mail.subject, /Re: Login fails \[FB-/);
  assert.match(mail.from, /support@shereboytechltd\.site/);
  assert.ok(mail.html.includes('a fix is on the way'));
  assert.equal((await dbRows('feedback')).find(f => f.id === withEmail.id).status, 'responded', 'status follows the reply');

  // Feedback without an email (e.g. sent from inside an app) can only get a recorded reply
  await fetch(`${DB}/rest/v1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: 'FB-20260101-A0A0A0', product_id: PRODUCTS[1].id, rating: 2, category: 'complaint', subject: 'Slow app', message: 'Pages take a long time to load.', name: null, email: null, source: 'achiever-app', ai_status: 'off' }) });
  const anon = (await dbRows('feedback')).find(f => f.email === null && f.subject === 'Slow app');
  await settle();
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
  const anonYes = await submit({ product: 'shereblognews', name: 'Bisi Adeyemi', subject: 'Nice', message: 'Clean design and fast pages.', rating: '4', allow_publish: 'true' });
  assert.equal(yes.status, 201);
  assert.equal(anonYes.status, 201);
  const fbNo = (await dbRows('feedback')).find(f => f.reference === noPerm.data.reference);
  const ts = await dbRows('testimonials');
  assert.ok(!ts.some(t => t.feedback_id === fbNo.id), 'no candidate without permission');
  const t = ts.find(x => x.quote === 'Best Nigerian news app I use daily.');
  assert.equal(t.status, 'pending');
  assert.equal(t.display_name, 'Tunde');
  assert.equal(ts.find(x => x.quote === 'Clean design and fast pages.').display_name, 'Bisi Adeyemi');

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


// ---------- Feedback forwarded from inside a product (e.g. JOB RUSH Help & Feedback) ----------
function forward(body, { secret = 'test-ingest-secret', timestamp = Math.floor(Date.now() / 1000), tamper = false } = {}) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return fetch(`${BASE}/api/feedback/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feedback-Timestamp': String(timestamp), 'X-Feedback-Signature': `sha256=${signature}` }, body: tamper ? raw.replace('Slow', 'Fast') : raw })
    .then(async r => ({ status: r.status, data: await r.json() }));
}
const appItem = (x = {}) => ({ product: 'job-rush', source: 'job-rush-app', externalId: crypto.randomUUID(), type: 'bug_report', message: 'Slow loading on the jobs list in the app.', submittedAt: '2026-10-01T09:00:00.000Z', ...x });

test('app feedback: only correctly signed forwards are accepted', async () => {
  assert.equal((await fetch(`${BASE}/api/feedback/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(appItem()) })).status, 401);
  assert.equal((await forward(appItem(), { secret: 'wrong-secret' })).status, 401);
  assert.equal((await forward(appItem(), { tamper: true })).status, 401);
  assert.equal((await forward(appItem(), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 401, 'old signatures are refused');
  assert.equal((await forward(appItem({ product: 'no-such-product' }))).status, 404);
  assert.equal((await forward(appItem({ type: 'praise' }))).status, 400);
  assert.equal((await forward(appItem({ rating: 9 }))).status, 400);
});

test('app feedback: stored once, without an invented rating, and shown in the dashboard', async () => {
  const item = appItem();
  const first = await forward(item);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const again = await forward({ ...item }, { timestamp: Math.floor(Date.now() / 1000) + 1 }); // a later retry is signed afresh
  assert.equal(again.data.duplicate, true, 'a retry or backfill is not stored twice');
  assert.equal(again.data.reference, first.data.reference);
  const rows = (await dbRows('feedback')).filter(r => r.external_id === item.externalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rating, null);
  assert.equal(rows[0].category, 'bug');
  assert.equal(rows[0].source, 'job-rush-app');
  assert.equal(rows[0].created_at, item.submittedAt, 'keeps the time it was really sent');
  assert.equal(rows[0].allow_publish, false, 'never becomes a testimonial');

  const list = (await admin.req('/api/feedback-admin/items?source=app')).data;
  assert.ok(list.items.length >= 1 && list.items.every(i => i.source !== 'website'));
  assert.ok((await admin.req('/api/feedback-admin/items?source=website')).data.items.every(i => i.source === 'website'));
  const detail = (await admin.req(`/api/feedback-admin/items/${rows[0].id}`)).data.item;
  assert.equal(detail.message, item.message);
  assert.equal(detail.product.name, 'JOB RUSH');
});

test('app feedback without ratings leaves the averages honest', async () => {
  const all = await dbRows('feedback');
  const ratings = all.map(r => r.rating).filter(Number.isFinite);
  const expected = Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 10) / 10;
  const o = (await admin.req('/api/feedback-admin/overview')).data;
  assert.equal(o.total, all.length);
  assert.equal(o.avgRating, expected);
  assert.equal(o.unrated, all.filter(r => r.rating === null).length);
  assert.ok(o.sources.some(x => x.source === 'job-rush-app'));
  assert.equal(o.ratings.reduce((n, r) => n + r.count, 0), ratings.length);
  const csv = (await admin.req('/api/feedback-admin/export.csv')).text;
  assert.ok(csv.includes('job-rush-app'));
});


// ---------- Customer emails and the AI assistant ----------
const emailsTo = (addr) => resend.state.emails.filter(m => m.to.includes(addr));
const rowOf = async (reference) => (await dbRows('feedback')).find(f => f.reference === reference);

test('confirmation: sent after the feedback is saved, with the reference, and recorded on the ticket', async () => {
  const r = await submit({ name: 'Chidi Okafor', email: 'chidi@example.com', subject: 'Search is great', message: 'I love how fast the job search is now.' });
  assert.equal(r.status, 201);
  await settle();
  const row = await rowOf(r.data.reference);
  assert.equal(row.confirmation_status, 'sent');
  const mails = emailsTo('chidi@example.com');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, new RegExp(r.data.reference));
  assert.ok(mails[0].html.includes('Thank you for contacting SHEREBOY TECH LTD') && mails[0].html.includes(r.data.reference));
  assert.ok(mails[0].html.includes('may contact you'), 'says the team may get in touch');
  assert.ok(mails[0].text.includes(r.data.reference), 'plain-text version too');
  const logged = (await dbRows('feedback_emails')).filter(e => e.feedback_id === row.id);
  assert.deepEqual(logged.map(e => [e.kind, e.status]), [['confirmation', 'sent']]);
});

test('confirmation: a failed email never loses the feedback, and a retry sends it exactly once', async () => {
  resend.state.mode = '500'; resend.state.failTimes = 1;
  const r = await submit({ name: 'Ngozi Eze', email: 'ngozi@example.com', subject: 'Question about alerts', message: 'How do I turn on job alerts for Lagos?' });
  assert.equal(r.status, 201, 'the customer is told it was saved');
  await settle();
  let row = await rowOf(r.data.reference);
  assert.equal(row.confirmation_status, 'failed');
  assert.match(row.confirmation_error, /Internal error/);
  const detail = (await admin.req(`/api/feedback-admin/items/${row.id}`)).data;
  assert.equal(detail.item.confirmation_status, 'failed');
  const retry = await admin.req(`/api/feedback-admin/items/${row.id}/confirmation/retry`, { method: 'POST', body: {} });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.email.status, 'sent');
  row = await rowOf(r.data.reference);
  assert.equal(row.confirmation_status, 'sent');
  assert.equal(emailsTo('ngozi@example.com').length, 1);
  assert.equal((await dbRows('feedback')).filter(f => f.subject === 'Question about alerts').length, 1, 'no duplicate feedback');
  assert.equal((await admin.req(`/api/feedback-admin/items/${row.id}/confirmation/retry`, { method: 'POST', body: {} })).status, 409, 'never sent twice');
});

test('AI: every submission is analysed; sensitive or low-rated feedback is flagged for a person', async () => {
  const happy = await rowOf((await submit({ name: 'Ife', email: 'ife@example.com', subject: 'Excellent', message: 'Thank you, the app is excellent and easy to use.' })).data.reference);
  const money = await submit({ name: 'Musa Bello', email: 'musa@example.com', rating: '4', category: 'complaint', subject: 'Charged twice', message: 'I was charged twice for my subscription. I want a refund.' });
  const low = await submit({ name: 'Ada Obi', email: 'adao@example.com', rating: '1', category: 'bug', subject: 'App crashes', message: 'The app is broken and crashes when I open messages.' });
  await settle();
  const h = await rowOf(happy.reference);
  assert.equal(h.ai_status, 'done');
  assert.equal(h.sentiment, 'positive');
  assert.equal(h.ai_classification, 'positive_review');
  assert.equal(h.needs_attention, false);
  const m = await rowOf(money.data.reference);
  assert.equal(m.needs_attention, true, 'money is flagged even though the AI did not escalate');
  assert.match(m.attention_reason, /money/);
  const l = await rowOf(low.data.reference);
  assert.equal(l.needs_attention, true);
  assert.match(l.attention_reason, /Low rating/);
  assert.deepEqual(l.ai_follow_up_questions.length, 2);
  // The customer's words are passed as data inside a fenced block, with the safety rules
  const call = gemini.state.calls.find(c => c.prompt.includes('Charged twice'));
  assert.match(call.system, /Never invent company policies/);
  assert.match(call.prompt, /<<<CUSTOMER MESSAGE[\s\S]*refund[\s\S]*CUSTOMER MESSAGE>>>/);
  const o = (await admin.req('/api/feedback-admin/overview')).data;
  assert.ok(o.comms);
  const rows = await dbRows('feedback');
  assert.equal(o.sentiment.positive, rows.filter(r => r.sentiment === 'positive').length);
  assert.equal(o.needsAttention, rows.filter(r => r.needs_attention && !['resolved', 'archived'].includes(r.status)).length);
  const flagged = (await admin.req('/api/feedback-admin/items?flag=attention')).data.items;
  assert.ok(flagged.length >= 2 && flagged.every(i => i.needs_attention));
  assert.ok((await admin.req('/api/feedback-admin/items?sentiment=positive')).data.items.every(i => i.sentiment === 'positive'));
});

test('AI: if the AI service fails, feedback and its confirmation still go through', async () => {
  gemini.state.mode = 'fail';
  try {
    const r = await submit({ name: 'Kemi', email: 'kemi@example.com', subject: 'Profile photo', message: 'Where do I change my profile photo?' });
    assert.equal(r.status, 201);
    await settle();
    const row = await rowOf(r.data.reference);
    assert.equal(row.ai_status, 'failed');
    assert.equal(row.confirmation_status, 'sent');
    const c = await admin.req(`/api/feedback-admin/items/${row.id}/compose`, { method: 'POST', body: { action: 'generate', instruction: 'Explain where the setting is.' } });
    assert.equal(c.status, 503);
    assert.ok(!JSON.stringify(c.data).includes('Internal detail'), 'provider errors are not passed on');
    const log = (await dbRows('feedback_ai_log')).filter(l => l.feedback_id === row.id);
    assert.ok(log.some(l => l.action === 'analyze' && l.outcome === 'failed'));
  } finally { gemini.state.mode = 'ok'; }
});

test('AI messages for administrators: drafted on request, never sent until Send is pressed', async () => {
  const row = (await dbRows('feedback')).find(f => f.subject === 'App crashes');
  const sentBefore = resend.state.emails.length;
  const g = await editor.req(`/api/feedback-admin/items/${row.id}/compose`, { method: 'POST', body: { action: 'generate', tone: 'apologetic', instruction: 'Ask the customer to explain the problem and send a screenshot.' } });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.match(g.data.draft.subject, new RegExp(row.reference));
  assert.match(g.data.draft.body, /Ask the customer to explain/);
  assert.match(gemini.state.calls.at(-1).prompt, /Tone: sincerely apologetic/);
  for (const action of ['regenerate', 'improve', 'shorter', 'professional']) {
    const r = await editor.req(`/api/feedback-admin/items/${row.id}/compose`, { method: 'POST', body: { action, draft: 'Hello, please send a screenshot of the error.' } });
    assert.equal(r.status, 200, action);
  }
  assert.equal((await editor.req(`/api/feedback-admin/items/${row.id}/compose`, { method: 'POST', body: { action: 'improve', draft: '' } })).status, 400, 'nothing to improve');
  assert.equal(resend.state.emails.length, sentBefore, 'generating never sends');

  const send = await editor.req(`/api/feedback-admin/items/${row.id}/emails`, { method: 'POST', body: { kind: 'info_request', subject: g.data.draft.subject, body: 'Hello Ada,\n\nSorry about this. Could you send a screenshot of the error?\n\nKind regards', ai_assisted: true } });
  assert.equal(send.status, 201, JSON.stringify(send.data));
  assert.equal(send.data.email.status, 'sent');
  const mail = resend.state.emails.at(-1);
  assert.deepEqual(mail.to, ['adao@example.com']);
  assert.ok(mail.html.includes('Could you send a screenshot'));
  let ticket = await rowOf(row.reference);
  assert.equal(ticket.awaiting_customer, true);
  assert.equal(ticket.status, 'responded');

  const back = await editor.req(`/api/feedback-admin/items/${row.id}/customer-reply`, { method: 'POST', body: { body: 'Here is what happens: the screen goes white.' } });
  assert.equal(back.status, 201);
  ticket = await rowOf(row.reference);
  assert.equal(ticket.awaiting_customer, false);
  const convo = (await admin.req(`/api/feedback-admin/items/${row.id}`)).data.emails;
  assert.deepEqual(convo.map(e => [e.direction, e.kind, e.status]), [['outbound', 'confirmation', 'sent'], ['outbound', 'info_request', 'sent'], ['inbound', 'customer_reply', 'received']]);
  assert.equal(convo[1].ai_generated, true);
  assert.equal(convo[1].author, 'fb.editor');
});

test('emails to customers: failures are recorded and can be retried without sending twice', async () => {
  const row = (await dbRows('feedback')).find(f => f.subject === 'Excellent');
  resend.state.mode = '500'; resend.state.failTimes = 1;
  const r = await admin.req(`/api/feedback-admin/items/${row.id}/emails`, { method: 'POST', body: { kind: 'reply', subject: 'Thank you', body: 'Thank you so much for the kind words, Ife.' } });
  assert.equal(r.data.email.status, 'failed');
  const before = emailsTo('ife@example.com').length;
  const retry = await admin.req(`/api/feedback-admin/emails/${r.data.email.id}/retry`, { method: 'POST', body: {} });
  assert.equal(retry.data.email.status, 'sent');
  assert.equal(retry.data.email.attempts, 2);
  assert.equal(emailsTo('ife@example.com').length, before + 1);
  assert.equal((await admin.req(`/api/feedback-admin/emails/${r.data.email.id}/retry`, { method: 'POST', body: {} })).status, 409);
});

test('status emails: Under Review and Resolved notify the customer once each', async () => {
  const row = (await dbRows('feedback')).find(f => f.subject === 'Search is great');
  const r1 = await admin.req(`/api/feedback-admin/items/${row.id}`, { method: 'PATCH', body: { status: 'under_review' } });
  assert.equal(r1.data.statusEmail.status, 'sent');
  await admin.req(`/api/feedback-admin/items/${row.id}`, { method: 'PATCH', body: { status: 'in_progress' } });
  const r2 = await admin.req(`/api/feedback-admin/items/${row.id}`, { method: 'PATCH', body: { status: 'under_review' } });
  assert.equal(r2.data.statusEmail, null, 'not repeated');
  const r3 = await admin.req(`/api/feedback-admin/items/${row.id}`, { method: 'PATCH', body: { status: 'resolved' } });
  assert.equal(r3.data.statusEmail.status, 'sent');
  const subjects = emailsTo('chidi@example.com').map(m => m.subject);
  assert.equal(subjects.filter(x => /being reviewed/.test(x)).length, 1);
  assert.equal(subjects.filter(x => /resolved/.test(x)).length, 1);
  assert.equal((await editor.req('/api/feedback-admin/ai/settings', { method: 'PUT', body: { status_emails_enabled: false } })).status, 403, 'only administrators change settings');
});

test('automatic AI replies: off by default, held for approval when required, always disclosed', async () => {
  const sentBefore = resend.state.emails.length;
  const off = await submit({ name: 'Tolu', email: 'tolu@example.com', subject: 'Nice update', message: 'Thank you for the new dark mode, it looks great.' });
  await settle();
  assert.ok(!(await dbRows('feedback_emails')).some(e => e.kind === 'ai_reply'), 'nothing automatic while it is off');
  assert.equal(resend.state.emails.length, sentBefore + 1, 'only the confirmation');

  const on = await admin.req('/api/feedback-admin/ai/settings', { method: 'PUT', body: { auto_reply_enabled: true, require_approval: true } });
  assert.equal(on.status, 200);
  const held = await submit({ name: 'Yemi', email: 'yemi@example.com', subject: 'Great support', message: 'Thank you, your team was great when I asked for help.' });
  const sensitive = await submit({ name: 'Obi', email: 'obi@example.com', subject: 'Payment', message: 'My payment failed but my card was debited. Please help.' });
  await settle();
  const pending = (await dbRows('feedback_emails')).filter(e => e.kind === 'ai_reply');
  assert.equal(pending.length, 1, 'only the safe one gets a draft');
  assert.equal(pending[0].status, 'pending_approval');
  assert.ok(!emailsTo('yemi@example.com').some(m => /^Re:/.test(m.subject)), 'not sent before approval');
  const obiRow = await rowOf(sensitive.data.reference);
  assert.ok((await dbRows('feedback_ai_log')).some(l => l.feedback_id === obiRow.id && l.action === 'auto_reply' && l.outcome === 'held'));

  const overview = (await admin.req('/api/feedback-admin/ai/overview')).data;
  assert.equal(overview.pendingApproval.length, 1);
  assert.ok(overview.needsAttention.some(x => x.reference === sensitive.data.reference));
  assert.ok(overview.unanswered.some(x => x.reference === held.data.reference));

  const approved = await editor.req(`/api/feedback-admin/emails/${pending[0].id}/approve`, { method: 'POST', body: { body: 'Hello Yemi,\n\nThank you, we have passed your kind words to the team.' } });
  assert.equal(approved.data.email.status, 'sent');
  assert.ok(approved.data.email.body.includes('written by the SHEREBOY TECH LTD AI assistant'), 'disclosure is kept even when the text was edited');
  assert.equal((await editor.req(`/api/feedback-admin/emails/${pending[0].id}/approve`, { method: 'POST', body: {} })).status, 409, 'cannot be sent twice');
  assert.equal((await rowOf(held.data.reference)).ai_handled, true);

  await admin.req('/api/feedback-admin/ai/settings', { method: 'PUT', body: { require_approval: false } });
  const auto = await submit({ name: 'Zainab', email: 'zainab@example.com', subject: 'Lovely', message: 'Thank you for building this, I love it.' });
  await settle();
  for (let i = 0; i < 40 && !emailsTo('zainab@example.com').some(m => /^Re:/.test(m.subject)); i += 1) await sleep(50);
  const reply = emailsTo('zainab@example.com').find(m => /^Re:/.test(m.subject));
  assert.ok(reply, 'sent automatically');
  assert.ok(reply.text.includes('written by the SHEREBOY TECH LTD AI assistant'));
  const autoRow = await rowOf(auto.data.reference);
  assert.equal(autoRow.ai_handled, true);
  assert.equal(autoRow.status, 'responded');

  // A draft that promises a refund or a fix is held, even for happy feedback
  gemini.state.reply = 'Hello, thank you! We have fixed this and will refund you within 3 days, guaranteed.';
  try {
    const risky = await submit({ name: 'Dayo', email: 'dayo@example.com', subject: 'Thanks', message: 'Thank you for the great service last week.' });
    await settle();
    await sleep(200);
    assert.ok(!emailsTo('dayo@example.com').some(m => /^Re:/.test(m.subject)), 'not sent');
    const riskyRow = await rowOf(risky.data.reference);
    assert.ok((await dbRows('feedback_ai_log')).some(l => l.feedback_id === riskyRow.id && l.outcome === 'held' && /refunds|guarantees|timelines/.test(l.detail)));
  } finally { gemini.state.reply = null; }
  await admin.req('/api/feedback-admin/ai/settings', { method: 'PUT', body: { auto_reply_enabled: false, require_approval: true } });
  void off;
});

test('discarding an AI draft sends nothing', async () => {
  await admin.req('/api/feedback-admin/ai/settings', { method: 'PUT', body: { auto_reply_enabled: true, require_approval: true } });
  const r = await submit({ name: 'Efe', email: 'efe@example.com', subject: 'Good work', message: 'Thank you, the new search filters are great.' });
  await settle();
  const row = await rowOf(r.data.reference);
  const draft = (await dbRows('feedback_emails')).find(e => e.feedback_id === row.id && e.kind === 'ai_reply');
  assert.equal((await admin.req(`/api/feedback-admin/emails/${draft.id}/discard`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await dbRows('feedback_emails')).find(e => e.id === draft.id).status, 'discarded');
  assert.ok(!emailsTo('efe@example.com').some(m => /^Re:/.test(m.subject)));
  await admin.req('/api/feedback-admin/ai/settings', { method: 'PUT', body: { auto_reply_enabled: false } });
});

test('before the email and AI database update: feedback is saved, confirmed by email, and the dashboard works', async () => {
  const base3 = `http://127.0.0.1:${PORT3}`;
  const fd = new FormData();
  Object.entries({ product: 'job-rush', rating: '4', category: 'general', subject: 'Old database', message: 'Sent before the latest database update.', name: 'Femi', email: 'femi@example.com' }).forEach(([k, v]) => fd.append(k, v));
  const r = await fetch(`${base3}/api/feedback`, { method: 'POST', headers: { 'X-Forwarded-For': visitor() }, body: fd });
  assert.equal(r.status, 201);
  const { reference } = await r.json();
  for (let i = 0; i < 40 && !emailsTo('femi@example.com').length; i += 1) await sleep(50);
  assert.ok(emailsTo('femi@example.com').some(m => m.subject.includes(reference)), 'confirmation still sent');
  // Same session secret, different server: sign in there
  const login = await fetch(`${base3}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': visitor() }, body: JSON.stringify({ username: 'testadmin', password: PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = (p) => fetch(base3 + p, { headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' } }).then(async x => ({ status: x.status, data: await x.json() }));
  const o = await get('/api/feedback-admin/overview');
  assert.equal(o.status, 200, JSON.stringify(o.data));
  assert.equal(o.data.comms, false);
  const list = await get('/api/feedback-admin/items');
  const item = list.data.items.find(i => i.reference === reference);
  assert.ok(item, 'appears in All Feedback');
  const detail = await get(`/api/feedback-admin/items/${item.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.comms, false);
  const ai = await get('/api/feedback-admin/ai/overview');
  assert.equal(ai.status, 409);
  assert.match(ai.data.error, /2026-11-09-feedback-email-ai\.sql/);
});
