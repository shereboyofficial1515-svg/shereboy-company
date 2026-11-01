// test/email.test.js — run with: npm test
// The real server in production mode, against an in-memory database stand-in and a
// fake Resend. No real email is sent and no real database or service is contacted.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { startFakeResend } = require('./support/fake-resend');
const { sanitizeEmailHtml, buildMessage } = require('../server/mail/render');

const PORT = 10991; const DB_PORT = 10992; const DB2_PORT = 10993; const PORT2 = 10994;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `http://127.0.0.1:${DB_PORT}`;
const WEBHOOK_SECRET = `whsec_${Buffer.from('test-webhook-secret-for-signing!').toString('base64')}`;
const ADMIN_PASSWORD = crypto.randomBytes(12).toString('hex');
const API_KEY = 're_test_key_never_sent_anywhere';
const procs = [];
let resend;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('Timed out waiting'); await sleep(60); } };
const dbRows = async (t) => (await fetch(`${DB}/__db`).then(r => r.json()))[t] || [];
const dbPatch = (t, filter, body) => fetch(`${DB}/rest/v1/${t}?${filter}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// A different "visitor" for each call, so rate limits are only hit where a test wants that
let ipCounter = 0;
const visitor = () => { ipCounter += 1; return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`; };

function client() {
  let cookie = ''; let csrf = '';
  const ip = visitor();
  const req = async (p, { method = 'GET', body, noCsrf, headers = {} } = {}) => {
    const h = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': ip, ...headers };
    if (cookie) h.Cookie = cookie;
    if (method !== 'GET' && csrf && !noCsrf) h['X-CSRF-Token'] = csrf;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(BASE + p, { method, headers: h, redirect: 'manual', body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, text, headers: r.headers };
  };
  return { req, async login(username, password) { const r = await req('/api/auth/login', { method: 'POST', body: { username, password } }); csrf = r.data.csrfToken || ''; return r; } };
}

const publicPost = (p, body, ip = visitor()) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const subscribe = (email, extra = {}, ip) => publicPost('/api/newsletter/subscribe', { email, source: 'homepage', consent: true, ...extra }, ip);
const mailTo = (email) => resend.state.emails.filter(m => m.to.includes(email));
const tokenFrom = (html) => decodeURIComponent(/newsletter\/confirm\?token=([^"&]+)/.exec(html)[1]);

async function confirmedSubscriber(email, extra) {
  await subscribe(email, extra);
  const mail = await until(() => mailTo(email).find(m => /confirm/i.test(m.subject)));
  const r = await publicPost('/api/newsletter/confirm', { token: tokenFrom(mail.html) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

function signed(event, id = `msg_${crypto.randomUUID()}`, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace('whsec_', ''), 'base64');
  const signature = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');
  return fetch(`${BASE}/api/email/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }, body: payload });
}
const event = (type, data) => ({ type, created_at: new Date().toISOString(), data: { created_at: new Date().toISOString(), ...data } });

let admin;
async function sendCampaign(fields, sendBody = {}) {
  const made = await admin.req('/api/email/campaigns', { method: 'POST', body: { name: 'T', subject: `Subject ${crypto.randomUUID()}`, body_html: '<p>Hello {{first_name}}</p>', mode: 'newsletter', audience: {}, ...fields } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const id = made.data.campaign.id;
  const est = await admin.req(`/api/email/campaigns/${id}/estimate`);
  const sent = await admin.req(`/api/email/campaigns/${id}/send`, { method: 'POST', body: { confirmCount: est.data.count, ...sendBody } });
  return { id, sent, count: est.data.count };
}
const campaignRow = async (id) => (await dbRows('email_campaigns')).find(c => c.id === id);
const recipientsOf = async (id) => (await dbRows('email_campaign_recipients')).filter(r => r.campaign_id === id);
const finished = (id) => until(async () => { const c = await campaignRow(id); return ['completed', 'failed'].includes(c.status) ? c : null; });

function startServer(port, dbPort, extraEnv) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production', PORT: String(port), SESSION_SECRET: 'x'.repeat(48),
      SUPABASE_URL: `http://127.0.0.1:${dbPort}`, SUPABASE_SERVICE_ROLE_KEY: 'test-key',
      ADMIN_USERNAME: 'testadmin', ADMIN_PASSWORD_HASH: bcrypt.hashSync(ADMIN_PASSWORD, 4),
      RESEND_API_KEY: API_KEY, RESEND_BASE_URL: resend.url, RESEND_FROM_EMAIL: 'SHEREBOY TECH LTD <support@shereboytechltd.site>', RESEND_REPLY_TO: 'support@shereboytechltd.site',
      RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET, APP_BASE_URL: 'https://shereboytechltd.site', EMAIL_TOKEN_SECRET: 'test-token-secret', EMAIL_CRON_SECRET: 'test-cron-secret',
      EMAIL_WORKER_INTERVAL_MS: '60', EMAIL_BATCH_SIZE: '2', EMAIL_LARGE_AUDIENCE_THRESHOLD: '1000', EMAIL_INDIVIDUAL_MAX_RECIPIENTS: '2', EMAIL_INDIVIDUAL_DAILY_LIMIT: '4',
      BLOG_API_BASE_URL: 'http://127.0.0.1:9', AFFILIATE_API_BASE_URL: 'http://127.0.0.1:9', SERVICE_WAKE_WINDOW_SECONDS: '1', BLOG_FETCH_TIMEOUT_MS: '100', AFFILIATE_FETCH_TIMEOUT_MS: '100', ...extraEnv
    },
    stdio: 'ignore'
  });
  procs.push(p);
  return until(() => fetch(`http://127.0.0.1:${port}/robots.txt`).then(r => r.ok).catch(() => false));
}

before(async () => {
  resend = await startFakeResend();
  const seedPath = path.join(os.tmpdir(), `email-test-seed-${process.pid}.json`);
  fs.writeFileSync(seedPath, JSON.stringify({
    company_settings: [{ id: 1, company_name: 'SHEREBOY TECH LTD' }], services: [], projects: [], reviews: [], blog_posts: [], contact_messages: [], activity_log: [], users: [], media_assets: []
  }));
  for (const args of [[seedPath, String(DB_PORT)], [seedPath, String(DB2_PORT), '--unmigrated']]) {
    procs.push(spawn(process.execPath, [path.join(__dirname, 'support', 'mock-db.js'), ...args], { stdio: 'ignore' }));
  }
  await sleep(500);
  await startServer(PORT, DB_PORT);
  await startServer(PORT2, DB2_PORT);
  admin = client();
  const r = await admin.login('testadmin', ADMIN_PASSWORD);
  assert.equal(r.status, 200);
});
after(() => { procs.forEach(p => p.kill()); resend && resend.close(); });

// ---------- Rendering ----------
test('email HTML is sanitized, including source mode', () => {
  const dirty = '<script>alert(1)</script><p onclick="x()">Hi</p><img src="http://a/x.png" onerror="y()"><a href="javascript:alert(1)">bad</a><iframe src="https://e.com"></iframe><style>p{}</style><a class="evil email-btn" href="https://ok.example">ok</a>';
  const clean = sanitizeEmailHtml(dirty);
  for (const bad of ['script', 'onclick', 'onerror', 'javascript:', 'iframe', '<style', 'evil', 'http://a/x.png']) assert.ok(!clean.includes(bad), bad);
  assert.ok(clean.includes('https://ok.example'));
});

test('messages are table-based with inline styles, a button, an unsubscribe link and plain text', () => {
  const settings = { sender_name: 'SHEREBOY TECH LTD', footer_text: 'SHEREBOY TECH LTD', logo_url: '' };
  const { html, text } = buildMessage({ subject: 'S', preheader: 'P', bodyHtml: '<h1>Title</h1><p>Hi {{first_name}}</p><p><a class="email-btn" href="https://x.example/a">Go</a></p>', settings, firstName: '<b>Ada</b>', unsubscribeUrl: 'https://s/u?token=1' });
  assert.match(html, /role="presentation"/);
  assert.match(html, /<h1 style="/);
  assert.match(html, /bgcolor="#2563eb"[\s\S]*href="https:\/\/x\.example\/a"/);
  assert.ok(html.includes('https://s/u?token=1'));
  assert.ok(html.includes('&lt;b&gt;Ada'), 'names are escaped');
  assert.match(text, /Go \(https:\/\/x\.example\/a\)/);
  assert.match(text, /Unsubscribe: https:\/\/s\/u/);
});

// ---------- Subscription ----------
test('invalid addresses and missing consent are rejected', async () => {
  for (const email of ['nope', 'a@b', 'a b@c.com', '<x>@y.com', { a: 1 }]) assert.equal((await subscribe(email)).status, 400, String(email));
  assert.equal((await subscribe('ok@example.com', { consent: false })).status, 400);
  assert.equal((await dbRows('email_subscribers')).length, 0);
});

test('the hidden trap field stops bots without telling them', async () => {
  const r = await subscribe('bot@example.com', { website: 'http://spam' });
  assert.equal(r.status, 200);
  assert.equal((await dbRows('email_subscribers')).filter(s => s.email === 'bot@example.com').length, 0);
});

test('double opt-in: pending until confirmed, token stored only as a hash, single use', async () => {
  const email = 'Reader.One@Gmail.com';
  const lower = email.toLowerCase();
  assert.equal((await subscribe(email)).status, 200);
  let row = (await dbRows('email_subscribers')).find(s => s.email === lower);
  assert.equal(row.status, 'pending');
  assert.equal(row.signup_source, 'homepage');
  assert.ok(row.consent_text);

  const mail = mailTo(lower)[0];
  assert.match(mail.from, /support@shereboytechltd\.site/);
  const token = tokenFrom(mail.html);
  assert.ok(token.length >= 40);
  assert.equal(row.confirmation_token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(await dbRows('email_subscribers')).includes(token), 'raw token is not stored');

  // Opening the link (as a mail scanner does) changes nothing
  const page = await fetch(`${BASE}/newsletter/confirm?token=${encodeURIComponent(token)}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.match(await page.text(), /noindex/);
  const info = await fetch(`${BASE}/api/newsletter/confirm-info?token=${encodeURIComponent(token)}`).then(r => r.json());
  assert.match(info.email, /^r\*+@gmail\.com$/);
  assert.equal((await dbRows('email_subscribers')).find(s => s.email === lower).status, 'pending');

  assert.equal((await publicPost('/api/newsletter/confirm', { token })).status, 200);
  row = (await dbRows('email_subscribers')).find(s => s.email === lower);
  assert.equal(row.status, 'active');
  assert.equal(row.consent_status, 'confirmed');
  assert.ok(row.consent_timestamp && row.confirmed_at);
  assert.equal(row.confirmation_token_hash, null);
  assert.equal((await publicPost('/api/newsletter/confirm', { token })).status, 404, 'a used token is rejected');

  const welcome = await until(() => mailTo(lower).find(m => /welcome/i.test(m.subject)));
  assert.ok(welcome.headers['List-Unsubscribe'].includes('/api/newsletter/one-click?token='));
  assert.equal(welcome.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  await until(() => resend.state.contacts.find(c => c.email === lower && c.unsubscribed === false));
});

test('expired and made-up tokens are rejected', async () => {
  await subscribe('late@example.com');
  const token = tokenFrom(mailTo('late@example.com')[0].html);
  await dbPatch('email_subscribers', 'email=eq.late@example.com', { confirmation_expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await publicPost('/api/newsletter/confirm', { token })).status, 410);
  assert.equal((await dbRows('email_subscribers')).find(s => s.email === 'late@example.com').status, 'pending');
  assert.equal((await publicPost('/api/newsletter/confirm', { token: 'x'.repeat(43) })).status, 404);
  assert.equal((await publicPost('/api/newsletter/confirm', { token: { $ne: 1 } })).status, 404);
});

test('repeat requests give the same reply, no duplicate record and no mail flood', async () => {
  const email = 'twice@example.com';
  const a = await subscribe(email); const b = await subscribe(email);
  assert.equal(a.data.message, b.data.message);
  assert.equal((await dbRows('email_subscribers')).filter(s => s.email === email).length, 1);
  assert.equal(mailTo(email).length, 1, 'second request sends nothing');
  await confirmedSubscriber('active@example.com');
  await until(() => mailTo('active@example.com').find(m => /welcome/i.test(m.subject)));
  const before = mailTo('active@example.com').length;
  const c = await subscribe('active@example.com');
  assert.equal(c.data.message, a.data.message, 'an active subscriber is not revealed');
  assert.equal(mailTo('active@example.com').length, before);
});

test('the subscribe form is rate limited per visitor', async () => {
  const ip = visitor();
  const codes = [];
  for (let i = 0; i < 8; i += 1) codes.push((await subscribe(`limit${i}@example.com`, {}, ip)).status);
  assert.ok(codes.includes(429), codes.join());
});

// ---------- Access control ----------
test('only administrators reach the email center; writes need the CSRF token', async () => {
  const anon = client();
  for (const p of ['overview', 'subscribers', 'subscribers/export.csv', 'campaigns', 'templates', 'settings', 'segments']) assert.equal((await anon.req(`/api/email/${p}`)).status, 401, p);
  assert.equal((await anon.req('/api/email/campaigns', { method: 'POST', body: {} })).status, 401);

  const made = await admin.req('/api/admin/users', { method: 'POST', body: { username: 'mail.editor', password: 'editor-pass-123', role: 'editor' } });
  assert.equal(made.status, 201);
  const editor = client();
  assert.equal((await editor.login('mail.editor', 'editor-pass-123')).status, 200);
  for (const p of ['overview', 'subscribers', 'subscribers/export.csv', 'campaigns', 'templates', 'settings']) assert.equal((await editor.req(`/api/email/${p}`)).status, 403, p);
  assert.equal((await editor.req('/api/email/test', { method: 'POST', body: { to: 'x@example.com' } })).status, 403);

  assert.equal((await admin.req('/api/email/campaigns', { method: 'POST', noCsrf: true, body: {} })).status, 403);
});

test('API keys and tokens never reach the browser', async () => {
  for (const p of ['overview', 'settings']) {
    const r = await admin.req(`/api/email/${p}`);
    assert.equal(r.status, 200, p);
    for (const secret of [API_KEY, WEBHOOK_SECRET, 'test-token-secret', 'test-cron-secret']) assert.ok(!r.text.includes(secret), p);
  }
  const list = await admin.req('/api/email/subscribers?limit=100');
  assert.ok(!list.text.includes('confirmation_token_hash'));
  for (const f of ['/js/app.js', '/admin/email.js', '/']) assert.ok(!(await fetch(BASE + f).then(r => r.text())).includes('re_test'), f);
  assert.equal((await fetch(`${BASE}/api/newsletter/subscribers`)).status, 404);
});

test('settings: sender is locked to the verified domain; drafts and templates are sanitized', async () => {
  const bad = await admin.req('/api/email/settings', { method: 'PUT', body: { sender_email: 'someone@gmail.com' } });
  assert.equal(bad.status, 400);
  assert.equal((await admin.req('/api/email/settings', { method: 'PUT', body: { logo_url: 'http://insecure.example/a.png' } })).status, 400);
  const ok = await admin.req('/api/email/settings', { method: 'PUT', body: { sender_name: 'SHEREBOY TECH LTD', sender_email: 'news@shereboytechltd.site', welcome_subject: 'Welcome', welcome_body: '<p>Hi</p><script>x</script>', confirmation_expiry_hours: 24 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(!ok.data.settings.welcome_body.includes('script'));

  const tpl = await admin.req('/api/email/templates');
  assert.equal(tpl.data.templates.length, 8);
  const made = await admin.req('/api/email/templates', { method: 'POST', body: { name: 'X', subject: 'S', body_html: '<img src=x onerror=alert(1)>' } });
  assert.ok(!made.data.template.body_html.includes('onerror'));
  const draft = await admin.req('/api/email/campaigns', { method: 'POST', body: { subject: 'S', body_html: '<script>bad()</script><p>ok</p>', audience: {} } });
  assert.equal(draft.data.campaign.body_html, '<p>ok</p>');
  assert.equal((await admin.req(`/api/email/campaigns/${draft.data.campaign.id}`, { method: 'DELETE' })).status, 200);
  await admin.req('/api/email/settings', { method: 'PUT', body: { sender_name: 'SHEREBOY TECH LTD', welcome_subject: 'Welcome', welcome_body: '<p>Hi</p>', confirmation_expiry_hours: 24 } });
});

test('test email goes through Resend and is reported as accepted, not delivered', async () => {
  const r = await admin.req('/api/email/test', { method: 'POST', body: { to: 'me@outlook.com', subject: 'Hello', body_html: '<p>Test</p>' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.note, /does not yet prove/);
  const m = mailTo('me@outlook.com')[0];
  assert.equal(m.subject, '[TEST] Hello');
  assert.match(m.from, /shereboytechltd\.site/);
  assert.equal((await admin.req('/api/email/test', { method: 'POST', body: { to: 'a@a.co, b@b.co, c@c.co, d@d.co' } })).status, 400);
});

// ---------- Campaigns ----------
test('a campaign reaches only confirmed subscribers, in batches, with unsubscribe headers', async () => {
  await confirmedSubscriber('camp1@gmail.com', { first_name: 'Ada' });
  await confirmedSubscriber('camp2@yahoo.com');
  await confirmedSubscriber('camp3@outlook.com');
  await subscribe('never-confirmed@example.com');

  const { id, sent, count } = await sendCampaign({});
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  const active = (await dbRows('email_subscribers')).filter(s => s.status === 'active').length;
  assert.equal(count, active);

  const c = await finished(id);
  assert.equal(c.status, 'completed', c.last_error);
  const rows = await recipientsOf(id);
  assert.equal(rows.length, active);
  assert.ok(rows.every(r => r.status === 'accepted' && r.provider_id));
  assert.ok(!rows.some(r => r.email === 'never-confirmed@example.com'));

  const m = mailTo('camp1@gmail.com').find(x => x.tags && x.tags.some(t => t.value === id));
  assert.match(m.html, /Hello Ada/);
  assert.match(m.html, /newsletter\/unsubscribe\?token=/);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(m.from, /support@shereboytechltd\.site/);
  assert.equal(c.stats.delivered, 0, 'accepted is not counted as delivered');
  assert.equal(c.stats.accepted_total, active);
});

test('sending twice is refused, and only one set of emails goes out', async () => {
  const made = await admin.req('/api/email/campaigns', { method: 'POST', body: { subject: `Once ${crypto.randomUUID()}`, body_html: '<p>x</p>', audience: {} } });
  const id = made.data.campaign.id;
  const [a, b] = await Promise.all([1, 2].map(() => admin.req(`/api/email/campaigns/${id}/send`, { method: 'POST', body: {} })));
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  await finished(id);
  const sentTo = resend.state.emails.filter(m => m.tags && m.tags.some(t => t.value === id)).map(m => m.to[0]);
  assert.equal(new Set(sentTo).size, sentTo.length);
  assert.equal((await admin.req(`/api/email/campaigns/${id}`, { method: 'PUT', body: { subject: 'changed' } })).status, 409, 'sent campaigns stay as sent');
  assert.equal((await admin.req(`/api/email/campaigns/${id}`, { method: 'DELETE' })).status, 409);
});

test('the same subject again within a day needs explicit confirmation', async () => {
  const subject = `Repeat ${crypto.randomUUID()}`;
  const first = await sendCampaign({ subject });
  await finished(first.id);
  const second = await sendCampaign({ subject });
  assert.equal(second.sent.status, 409);
  assert.equal(second.sent.data.code, 'POSSIBLE_DUPLICATE');
  const again = await admin.req(`/api/email/campaigns/${second.id}/send`, { method: 'POST', body: { allowRepeat: true } });
  assert.equal(again.status, 202);
  await finished(second.id);
});

test('a lost reply from Resend does not cause duplicate emails', async () => {
  resend.state.mode = 'lost-reply'; resend.state.failTimes = 1;
  const { id } = await sendCampaign({});
  const c = await finished(id);
  assert.equal(c.status, 'completed', c.last_error);
  const sentTo = resend.state.emails.filter(m => m.tags && m.tags.some(t => t.value === id)).map(m => m.to[0]);
  assert.ok(sentTo.length > 0);
  assert.equal(new Set(sentTo).size, sentTo.length, 'nobody got it twice');
  assert.ok((await recipientsOf(id)).every(r => r.status === 'accepted'));
});

test('rate limits and server errors retry with backoff, then finish', async () => {
  for (const mode of ['429', '500']) {
    resend.state.mode = mode; resend.state.failTimes = 2;
    const { id } = await sendCampaign({});
    const c = await finished(id);
    assert.equal(c.status, 'completed', `${mode}: ${c.last_error}`);
    const sentTo = resend.state.emails.filter(m => m.tags && m.tags.some(t => t.value === id)).map(m => m.to[0]);
    assert.equal(new Set(sentTo).size, sentTo.length);
  }
});

test('an unverified domain stops the campaign clearly, and Resume sends only the rest', async () => {
  resend.state.mode = '403'; resend.state.failTimes = 1;
  const { id } = await sendCampaign({});
  const c = await finished(id);
  assert.equal(c.status, 'failed');
  assert.match(c.last_error, /not verified/);
  assert.equal((await admin.req(`/api/email/campaigns/${id}/resume`, { method: 'POST' })).status, 200);
  const done = await until(async () => { const x = await campaignRow(id); return x.status === 'completed' ? x : null; });
  const sentTo = resend.state.emails.filter(m => m.tags && m.tags.some(t => t.value === id)).map(m => m.to[0]);
  assert.equal(new Set(sentTo).size, sentTo.length);
  assert.ok(done.stats.accepted_total > 0);
});

test('a daily quota pauses the campaign without failing recipients', async () => {
  resend.state.mode = 'quota'; resend.state.failTimes = 1;
  const { id } = await sendCampaign({});
  const paused = await until(async () => { const x = await campaignRow(id); return x.last_error && /quota/i.test(x.last_error) ? x : null; });
  assert.equal(paused.status, 'sending');
  assert.ok(Date.parse(paused.next_run_at) > Date.now() + 30 * 60 * 1000);
  assert.ok((await recipientsOf(id)).every(r => r.status !== 'failed'));
  assert.equal((await admin.req(`/api/email/campaigns/${id}/cancel`, { method: 'POST' })).status, 200);
  assert.equal((await campaignRow(id)).status, 'cancelled');
});

test('scheduled campaigns wait, then send; they can be cancelled first', async () => {
  const made = await admin.req('/api/email/campaigns', { method: 'POST', body: { subject: `Later ${crypto.randomUUID()}`, body_html: '<p>x</p>', audience: {} } });
  const id = made.data.campaign.id;
  assert.equal((await admin.req(`/api/email/campaigns/${id}/schedule`, { method: 'POST', body: { scheduled_at: new Date(Date.now() - 1000).toISOString() } })).status, 400);
  const s = await admin.req(`/api/email/campaigns/${id}/schedule`, { method: 'POST', body: { scheduled_at: new Date(Date.now() + 3600000).toISOString() } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  await sleep(300);
  assert.equal((await campaignRow(id)).status, 'scheduled');
  await dbPatch('email_campaigns', `id=eq.${id}`, { scheduled_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await finished(id)).status, 'completed');

  const m2 = await admin.req('/api/email/campaigns', { method: 'POST', body: { subject: `Later ${crypto.randomUUID()}`, body_html: '<p>x</p>', audience: {} } });
  await admin.req(`/api/email/campaigns/${m2.data.campaign.id}/schedule`, { method: 'POST', body: { scheduled_at: new Date(Date.now() + 3600000).toISOString() } });
  assert.equal((await admin.req(`/api/email/campaigns/${m2.data.campaign.id}/cancel`, { method: 'POST' })).status, 200);
});

test('the wake-up endpoint needs its secret', async () => {
  assert.equal((await fetch(`${BASE}/api/email/cron`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${BASE}/api/email/cron`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${BASE}/api/email/cron`, { method: 'POST', headers: { Authorization: 'Bearer test-cron-secret' } })).status, 200);
});

test('individual email: acknowledged, limited in size and per day, from the company sender', async () => {
  const body = (emails) => ({ mode: 'individual', subject: `Direct ${crypto.randomUUID()}`, body_html: '<p>Hello</p>', audience: { emails } });
  const noAck = await sendCampaign(body(['client@gmail.com']));
  assert.equal(noAck.sent.status, 400);
  const tooMany = await sendCampaign(body(['a1@x.co', 'a2@x.co', 'a3@x.co']), { acknowledged: true });
  assert.equal(tooMany.sent.status, 400);
  assert.match(tooMany.sent.data.error, /at most 2/);
  const ok = await sendCampaign(body(['client@gmail.com', 'client2@yahoo.com']), { acknowledged: true });
  assert.equal(ok.sent.status, 202, JSON.stringify(ok.sent.data));
  await finished(ok.id);
  const m = mailTo('client@gmail.com')[0];
  assert.match(m.from, /shereboytechltd\.site/);
  assert.ok(!m.from.includes('gmail'));
  const ok2 = await sendCampaign(body(['c3@x.co', 'c4@x.co']), { acknowledged: true });
  assert.equal(ok2.sent.status, 202);
  await finished(ok2.id);
  const over = await sendCampaign(body(['c5@x.co']), { acknowledged: true });
  assert.equal(over.sent.status, 400);
  assert.match(over.sent.data.error, /per 24 hours/);
});

// ---------- Webhooks ----------
test('webhooks: unsigned and tampered requests are rejected', async () => {
  const plain = await fetch(`${BASE}/api/email/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(plain.status, 400);
  const forged = await signed(event('email.delivered', { email_id: 'x', to: ['a@b.co'] }), undefined, `whsec_${Buffer.from('wrong-secret-wrong-secret-wrong!').toString('base64')}`);
  assert.equal(forged.status, 400);
  assert.equal((await dbRows('email_events')).filter(e => e.type === 'email.delivered').length, 0);
});

test('webhooks: real statistics, idempotent, order-safe', async () => {
  const { id } = await sendCampaign({});
  await finished(id);
  const rows = await recipientsOf(id);
  const r = rows[0];
  const statsNow = async () => (await admin.req(`/api/email/campaigns/${id}`)).data.stats;
  assert.equal((await statsNow()).delivered, 0);

  const eventId = `msg_${crypto.randomUUID()}`;
  const delivered = event('email.delivered', { email_id: r.provider_id, to: [r.email], tags: { campaign_id: id } });
  assert.equal((await signed(delivered, eventId)).status, 200);
  assert.equal((await statsNow()).delivered, 1);
  // The same delivery again changes nothing
  const again = await signed(delivered, eventId).then(x => x.json());
  assert.equal(again.duplicate, true);
  assert.equal((await dbRows('email_events')).filter(e => e.event_key === eventId).length, 1);
  assert.equal((await statsNow()).delivered, 1);
  // An earlier state arriving late doesn't undo it
  await signed(event('email.sent', { email_id: r.provider_id, to: [r.email] }));
  assert.equal((await recipientsOf(id)).find(x => x.id === r.id).status, 'delivered');

  await signed(event('email.opened', { email_id: r.provider_id, to: [r.email] }));
  await signed(event('email.clicked', { email_id: r.provider_id, to: [r.email] }));
  const s = await statsNow();
  assert.equal(s.opened, 1);
  assert.equal(s.clicked, 1);
  assert.equal(s.delivered, 1);
  await signed(event('email.delivery_delayed', { email_id: rows[1].provider_id, to: [rows[1].email] }));
  assert.equal((await recipientsOf(id)).find(x => x.id === rows[1].id).status, 'delayed');
  // The stored summary catches up on its own
  await until(async () => (await campaignRow(id)).stats.delivered === 1);
});

test('bounces and complaints stop future email; temporary bounces do not', async () => {
  await confirmedSubscriber('hardbounce@example.com');
  await confirmedSubscriber('softbounce@example.com');
  await confirmedSubscriber('complainer@example.com');
  const { id } = await sendCampaign({});
  await finished(id);
  const rows = await recipientsOf(id);
  const of = (email) => rows.find(r => r.email === email);
  await signed(event('email.bounced', { email_id: of('hardbounce@example.com').provider_id, to: ['hardbounce@example.com'], bounce: { type: 'Permanent', message: 'No such mailbox' } }));
  await signed(event('email.bounced', { email_id: of('softbounce@example.com').provider_id, to: ['softbounce@example.com'], bounce: { type: 'Temporary', message: 'Mailbox full' } }));
  await signed(event('email.complained', { email_id: of('complainer@example.com').provider_id, to: ['complainer@example.com'] }));
  const subs = await dbRows('email_subscribers');
  assert.equal(subs.find(s => s.email === 'hardbounce@example.com').status, 'bounced');
  assert.equal(subs.find(s => s.email === 'complainer@example.com').status, 'complained');
  assert.equal(subs.find(s => s.email === 'softbounce@example.com').status, 'active');
  const sup = await dbRows('email_suppressions');
  assert.ok(sup.find(s => s.email === 'hardbounce@example.com' && s.reason === 'bounced'));
  assert.ok(sup.find(s => s.email === 'complainer@example.com' && s.reason === 'complained'));
  assert.ok(!sup.find(s => s.email === 'softbounce@example.com'));

  const next = await sendCampaign({});
  await finished(next.id);
  const nextEmails = (await recipientsOf(next.id)).map(r => r.email);
  assert.ok(!nextEmails.includes('hardbounce@example.com'));
  assert.ok(!nextEmails.includes('complainer@example.com'));
  assert.ok(nextEmails.includes('softbounce@example.com'));

  // The public form can't bring them back
  const before = mailTo('complainer@example.com').length;
  await subscribe('complainer@example.com');
  assert.equal(mailTo('complainer@example.com').length, before);
  assert.equal((await dbRows('email_subscribers')).find(s => s.email === 'complainer@example.com').status, 'complained');
});

// ---------- Unsubscribe ----------
const unsubToken = (m) => decodeURIComponent(/newsletter\/unsubscribe\?token=([^"&]+)/.exec(m.html)[1]);

test('unsubscribe page: no sign-in, signed token, takes effect, keeps a record', async () => {
  const email = 'leaver@example.com';
  await confirmedSubscriber(email);
  const welcome = await until(() => mailTo(email).find(m => /welcome/i.test(m.subject)));
  const token = unsubToken(welcome);

  assert.equal((await publicPost('/api/newsletter/unsubscribe', { token: `${token}x` })).status, 400);
  assert.equal((await publicPost('/api/newsletter/unsubscribe', { token: 'bGVhdmVyQGV4YW1wbGUuY29t.forged' })).status, 400);
  const page = await fetch(`${BASE}/newsletter/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.equal(page.status, 200);
  assert.equal((await dbRows('email_subscribers')).find(s => s.email === email).status, 'active', 'opening the page changes nothing');

  assert.equal((await publicPost('/api/newsletter/unsubscribe', { token })).status, 200);
  const row = (await dbRows('email_subscribers')).find(s => s.email === email);
  assert.equal(row.status, 'unsubscribed');
  assert.equal(row.consent_status, 'withdrawn');
  assert.ok(row.unsubscribed_at);
  assert.ok((await dbRows('email_suppressions')).find(s => s.email === email && s.reason === 'unsubscribed'));
  assert.ok((await dbRows('email_events')).find(e => e.email === email && e.type === 'local.unsubscribed'));
  await until(() => resend.state.contacts.find(c => c.email === email && c.unsubscribed === true));

  const next = await sendCampaign({});
  await finished(next.id);
  assert.ok(!(await recipientsOf(next.id)).some(r => r.email === email));
});

test('one-click unsubscribe works as mail apps call it (RFC 8058)', async () => {
  const email = 'oneclick@example.com';
  await confirmedSubscriber(email);
  const welcome = await until(() => mailTo(email).find(m => /welcome/i.test(m.subject)));
  const url = /<([^>]+)>/.exec(welcome.headers['List-Unsubscribe'])[1];
  assert.match(url, /^https:\/\/shereboytechltd\.site\/api\/newsletter\/one-click/);
  const local = url.replace('https://shereboytechltd.site', BASE);
  assert.equal((await fetch(local, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status, 200);
  assert.equal((await dbRows('email_subscribers')).find(s => s.email === email).status, 'unsubscribed');
  assert.equal((await fetch(`${BASE}/api/newsletter/one-click?token=forged.token`, { method: 'POST' })).status, 400);
});

test('someone opting out mid-campaign is skipped', async () => {
  const email = 'midway@example.com';
  await confirmedSubscriber(email);
  const made = await admin.req('/api/email/campaigns', { method: 'POST', body: { subject: `Mid ${crypto.randomUUID()}`, body_html: '<p>x</p>', audience: {} } });
  const id = made.data.campaign.id;
  // Queued for them, then they leave before their batch goes
  await dbPatch('email_subscribers', `email=eq.${email}`, { status: 'unsubscribed' });
  await fetch(`${DB}/rest/v1/email_suppressions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, reason: 'unsubscribed' }) });
  await fetch(`${DB}/rest/v1/email_campaign_recipients`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign_id: id, email, status: 'pending' }) });
  await dbPatch('email_campaigns', `id=eq.${id}`, { status: 'queued', recipients_built: true, recipient_count: 1 });
  await finished(id);
  const row = (await recipientsOf(id))[0];
  assert.equal(row.status, 'skipped');
  assert.ok(!resend.state.emails.some(m => m.to.includes(email) && m.tags && m.tags.some(t => t.value === id)));
});

test('nobody can be silently resubscribed: only their own new confirmation brings them back', async () => {
  const email = 'comeback@example.com';
  await confirmedSubscriber(email);
  const welcome = await until(() => mailTo(email).find(m => /welcome/i.test(m.subject)));
  await publicPost('/api/newsletter/unsubscribe', { token: unsubToken(welcome) });
  const id = (await dbRows('email_subscribers')).find(s => s.email === email).id;
  // No admin route exists for it
  for (const p of [`/api/email/subscribers/${id}/resubscribe`, `/api/email/subscribers/${id}/activate`]) assert.equal((await admin.req(p, { method: 'POST' })).status, 404);
  assert.equal((await admin.req(`/api/email/subscribers/${id}`, { method: 'PUT', body: { status: 'active' } })).status, 404);

  // Their own request stays unsubscribed until they confirm
  await dbPatch('email_subscribers', `email=eq.${email}`, { confirmation_sent_at: null });
  await subscribe(email);
  assert.equal((await dbRows('email_subscribers')).find(s => s.email === email).status, 'unsubscribed');
  const mail = mailTo(email).filter(m => /confirm/i.test(m.subject)).pop();
  assert.equal((await publicPost('/api/newsletter/confirm', { token: tokenFrom(mail.html) })).status, 200);
  assert.equal((await dbRows('email_subscribers')).find(s => s.email === email).status, 'active');
  assert.ok(!(await dbRows('email_suppressions')).find(s => s.email === email));
});

test('removing a subscriber keeps the address off future sends; export is safe', async () => {
  const email = 'erase@example.com';
  await confirmedSubscriber(email);
  await confirmedSubscriber('=formula@example.com');
  const csv = await admin.req('/api/email/subscribers/export.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.includes(`"'=formula@example.com"`), 'formula neutralised');
  assert.ok(!csv.text.includes('token'));

  const id = (await dbRows('email_subscribers')).find(s => s.email === email).id;
  const detail = await admin.req(`/api/email/subscribers/${id}`);
  assert.equal(detail.data.subscriber.email, email);
  assert.ok(!('confirmation_token_hash' in detail.data.subscriber));
  assert.equal((await admin.req(`/api/email/subscribers/${id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await dbRows('email_subscribers')).find(s => s.email === email));
  assert.ok((await dbRows('email_suppressions')).find(s => s.email === email));
  const before = mailTo(email).length;
  await subscribe(email);
  assert.equal(mailTo(email).length, before, 'a removed address is not contacted');

  const list = await admin.req('/api/email/subscribers?status=active&search=formula');
  assert.equal(list.data.total, 1);
  const overview = await admin.req('/api/email/overview');
  assert.ok(overview.data.subscribers.active >= 1);
  assert.ok(overview.data.subscribers.suppressions >= 1);
  assert.ok(overview.data.campaigns.sent >= 1);
});

// ---------- Before the migration ----------
test('before the database update, the site keeps working and says what is needed', async () => {
  const base2 = `http://127.0.0.1:${PORT2}`;
  const r = await fetch(`${base2}/api/newsletter/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', consent: true }) });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not open yet/);
  assert.equal((await fetch(`${base2}/`)).status, 200);
  assert.ok((await fetch(`${base2}/`).then(x => x.text())).includes('Stay Ahead of What'));
});

test('the newsletter section is on the homepage and in every footer, in plain HTML', async () => {
  for (const [p, sectioned] of [['/', true], ['/about', true], ['/services', true], ['/projects', true], ['/contact', false]]) {
    const t = await fetch(BASE + p).then(r => r.text());
    assert.ok(t.includes('footerNewsletterEmail'), `${p} footer`);
    assert.equal(t.includes('id="newsletterEmail"'), sectioned, `${p} section`);
    assert.equal((t.match(/<h1\b/g) || []).length, 1, p);
  }
  const home = await fetch(`${BASE}/`).then(r => r.text());
  assert.ok(home.includes('Subscribe to Updates'));
  assert.ok(home.includes('unsubscribe link'));
});

test('a send-only API key: subscribing still works, and contact sync does not hammer Resend', async () => {
  resend.state.contactsRestricted = true;
  try {
    await confirmedSubscriber('sendonly@example.com');
    await until(() => mailTo('sendonly@example.com').find(m => /welcome/i.test(m.subject)));
    await sleep(100);
    const calls = resend.state.contactCalls;
    await sleep(1000);
    assert.ok(resend.state.contactCalls - calls <= 1, 'no tight retry loop');
    const row = (await dbRows('email_subscribers')).find(s => s.email === 'sendonly@example.com');
    assert.equal(row.status, 'active');
    assert.equal(row.resend_sync_needed, true);
  } finally { resend.state.contactsRestricted = false; }
});
