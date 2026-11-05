// test/upload.test.js — run with: npm test
// Admin uploads against a stand-in database and storage, in production mode.
// Checks that a missing or private bucket gives an exact message, and that a correct
// setup works. Nothing here touches the real Supabase project.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const DB_PORT = 10996;
const PASSWORD = crypto.randomBytes(12).toString('hex');
const SERVERS = { missing: 10997, privateAsPublic: 10998, correct: 10999 };
const procs = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(32)]);

function start(port, bucket) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production', PORT: String(port), SESSION_SECRET: 'x'.repeat(48),
      SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`, SUPABASE_SERVICE_ROLE_KEY: 'test-key', SUPABASE_STORAGE_BUCKET: bucket, SUPABASE_PRIVATE_BUCKET: 'shereboy-private',
      ADMIN_USERNAME: 'testadmin', ADMIN_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4),
      BLOG_API_BASE_URL: 'http://127.0.0.1:9', AFFILIATE_API_BASE_URL: 'http://127.0.0.1:9', SERVICE_WAKE_WINDOW_SECONDS: '1'
    },
    stdio: 'ignore'
  });
  procs.push(p);
}

async function adminFor(port) {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i += 1) { try { await fetch(`${base}/robots.txt`); break; } catch { await sleep(100); } }
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' };
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'testadmin', password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();
  return {
    upload: async (fields = {}) => {
      const fd = new FormData();
      fd.append('file', new Blob([PNG], { type: 'image/png' }), 'logo.png');
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      const r = await fetch(`${base}/api/upload`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'X-Forwarded-Proto': 'https' }, body: fd });
      return { status: r.status, body: await r.json() };
    },
    get: async (p) => (await fetch(base + p, { headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' } })).json()
  };
}

before(async () => {
  const seed = path.join(os.tmpdir(), `upload-test-seed-${process.pid}.json`);
  fs.writeFileSync(seed, JSON.stringify({ company_settings: [{ id: 1 }], services: [], projects: [], reviews: [], blog_posts: [], contact_messages: [], activity_log: [], users: [], media_assets: [] }));
  procs.push(spawn(process.execPath, [path.join(__dirname, 'support', 'mock-db.js'), seed, String(DB_PORT)], { stdio: 'ignore' }));
  await sleep(400);
  start(SERVERS.missing, 'sheroboy-media'); // the typo found in the local .env
  start(SERVERS.privateAsPublic, 'shereboy-private');
  start(SERVERS.correct, 'shereboy-media');
});
after(() => procs.forEach(p => p.kill()));

test('a misspelt bucket name gives an exact message naming the bucket', async () => {
  const admin = await adminFor(SERVERS.missing);
  const r = await admin.upload();
  assert.equal(r.status, 500);
  assert.match(r.body.error, /"sheroboy-media" doesn't exist/);
  assert.match(r.body.error, /SUPABASE_STORAGE_BUCKET/);
  const sys = await admin.get('/api/system/overview');
  const check = sys.security.checks.find(c => c.label === 'Image uploads');
  assert.equal(check.ok, false);
  assert.match(check.detail, /sheroboy-media/);
});

test('a private bucket used for website images is caught before uploading', async () => {
  const admin = await adminFor(SERVERS.privateAsPublic);
  const r = await admin.upload();
  assert.equal(r.status, 500);
  assert.match(r.body.error, /is private/);
  assert.match(r.body.error, /Public bucket/);
});

test('with the right, public bucket, uploads work and appear in the media library', async () => {
  const admin = await adminFor(SERVERS.correct);
  const r = await admin.upload({ folder: 'media' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /\/storage\/v1\/object\/public\/shereboy-media\/media\/.+\.png$/);
  const doc = await admin.upload({ folder: 'documents', private: 'true' });
  assert.equal(doc.status, 200, JSON.stringify(doc.body));
  assert.equal(doc.body.url, null, 'private files get no public link');
  const lib = await admin.get('/api/media');
  assert.ok(lib.assets.some(a => a.url === r.body.url));
  const sys = await admin.get('/api/system/overview');
  assert.ok(sys.security.checks.filter(c => /uploads/.test(c.label)).every(c => c.ok));
});
