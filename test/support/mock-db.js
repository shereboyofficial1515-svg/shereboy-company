// Minimal in-memory PostgREST + Supabase Storage stand-in for tests. Never touches a real database.
// Usage: node mock-supabase.js <seed.json> [port] [--unmigrated]
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const seed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.argv[3] || 54321);
const MIGRATED = !process.argv.includes('--unmigrated');

const SCHEMA = {
  users: ['id', 'username', 'password_hash', 'role', 'created_at', 'updated_at'],
  company_settings: ['id', 'company_name', 'description', 'mission', 'vision', 'address', 'cac_number', 'cac_document_url', 'ceo_name', 'ceo_title', 'ceo_bio', 'ceo_photo_url', 'logo_url', 'email', 'whatsapp', 'phone', 'instagram_url', 'tiktok_url', 'youtube_url', 'updated_at', ...(MIGRATED ? ['core_values'] : [])],
  services: ['id', 'title', 'description', 'icon', 'display_order', 'published', 'created_at', 'updated_at', ...(MIGRATED ? ['benefits'] : [])],
  projects: ['id', 'title', 'description', 'category', 'image_url', 'technologies', 'client_name', 'completion_date', 'status', 'live_url', 'github_url', 'featured', 'published', 'created_at', 'updated_at', ...(MIGRATED ? ['preview_enabled', 'display_order'] : [])],
  reviews: ['id', 'client_name', 'client_position', 'review_text', 'client_image_url', 'rating', 'featured', 'published', 'created_at', 'updated_at'],
  categories: ['id', 'name', 'slug', 'created_at'],
  blog_posts: ['id', 'title', 'slug', 'excerpt', 'content', 'featured_image_url', 'category_id', 'author', 'featured', 'published', 'created_at', 'updated_at'],
  activity_log: ['id', 'user_id', 'action', 'details', 'created_at'],
  ai_chat_log: ['id', 'ip_hash', 'message_preview', 'created_at'],
  contact_messages: ['id', 'name', 'email', 'phone', 'subject', 'message', 'read', 'created_at'],
  ...(MIGRATED ? { media_assets: ['id', 'bucket', 'storage_path', 'url', 'file_name', 'mime_type', 'size_bytes', 'folder', 'description', 'is_private', 'uploaded_by', 'created_at', 'updated_at'] } : {})
};
const EMAIL_SCHEMA = {
  email_subscribers: ['id', 'email', 'first_name', 'status', 'consent_status', 'consent_timestamp', 'consent_text', 'signup_source', 'confirmation_token_hash', 'confirmation_expires_at', 'confirmation_sent_at', 'confirmed_at', 'unsubscribed_at', 'unsubscribe_source', 'resend_contact_id', 'resend_sync_needed', 'last_email_at', 'last_event', 'created_at', 'updated_at'],
  email_suppressions: ['id', 'email', 'reason', 'source', 'created_at', 'updated_at'],
  email_templates: ['id', 'template_key', 'name', 'category', 'subject', 'preheader', 'body_html', 'created_at', 'updated_at'],
  email_campaigns: ['id', 'name', 'mode', 'subject', 'preheader', 'body_html', 'reply_to', 'audience', 'status', 'scheduled_at', 'queued_at', 'started_at', 'completed_at', 'next_run_at', 'retry_count', 'recipients_built', 'recipient_count', 'stats', 'last_error', 'acknowledged_by', 'created_by', 'created_at', 'updated_at'],
  email_campaign_recipients: ['id', 'campaign_id', 'subscriber_id', 'email', 'first_name', 'status', 'batch_key', 'claimed_at', 'attempts', 'provider_id', 'accepted_at', 'delivered_at', 'opened_at', 'clicked_at', 'last_error', 'created_at', 'updated_at'],
  email_events: ['id', 'event_key', 'type', 'provider_id', 'email', 'campaign_id', 'detail', 'occurred_at', 'processed_at', 'created_at', 'updated_at'],
  email_settings: ['id', 'sender_name', 'sender_email', 'reply_to', 'newsletter_description', 'confirmation_subject', 'confirmation_intro', 'confirmation_expiry_hours', 'welcome_enabled', 'welcome_subject', 'welcome_body', 'footer_text', 'logo_url', 'contact_address', 'contact_email', 'contact_phone', 'created_at', 'updated_at']
};
if (MIGRATED) Object.assign(SCHEMA, EMAIL_SCHEMA);
const UNIQUE = { email_subscribers: ['email'], email_suppressions: ['email'], email_events: ['event_key'], email_campaign_recipients: ['campaign_id', 'email'], email_settings: ['id'] };
const clash = (t, row) => UNIQUE[t] && db[t].find(r => UNIQUE[t].every(c => r[c] === row[c] && row[c] !== undefined));
const DEFAULTS = {
  email_campaigns: { audience: {}, stats: {}, retry_count: 0, recipients_built: false, recipient_count: 0 },
  email_campaign_recipients: { attempts: 0 },
  email_subscribers: { resend_sync_needed: false },
  email_settings: { welcome_enabled: true },
  projects: { status: 'completed', featured: false, published: true, preview_enabled: true, display_order: 0, technologies: [] },
  services: { display_order: 0, published: true, benefits: [] },
  reviews: { rating: 5, featured: false, published: false },
  blog_posts: { author: 'SHEREBOY TECH LTD', featured: false, published: false },
  contact_messages: { read: false },
  users: { role: 'admin' },
  media_assets: { is_private: false }
};
// A seed may carry its own schema (e.g. the blog's) and many-to-one relations
if (seed.__schema) { Object.keys(SCHEMA).forEach(k => delete SCHEMA[k]); Object.assign(SCHEMA, seed.__schema); }
const RELATIONS = seed.__relations || {}; // { articles: { categories: 'category_id', users: 'author_id' } }
if (seed.__defaults) Object.assign(DEFAULTS, seed.__defaults);
const db = {};
Object.keys(SCHEMA).forEach(t => { db[t] = (seed[t] || []).map(r => normalise(t, r)); });
function normalise(t, r) {
  const row = {};
  SCHEMA[t].forEach(c => { row[c] = r[c] !== undefined ? r[c] : (DEFAULTS[t]?.[c] ?? null); });
  return row;
}
const BUCKETS = ['sheroboytech-media', 'sheroboy', 'sheroboytech-private'];
const files = new Map(); // bucket/path -> { buf, type }

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const missingCol = (t, c) => ({ code: '42703', message: `column ${t}.${c} does not exist`, details: null, hint: null });

function parseValue(op, raw) {
  if (op === 'in') return raw.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, ''));
  return raw;
}
function matches(row, col, op, val) {
  if (op.startsWith('not.')) return !matches(row, col, op.slice(4), val);
  const v = row[col];
  const s = v === null || v === undefined ? 'null' : String(v);
  switch (op) {
    case 'eq': return s === val;
    case 'neq': return s !== val;
    case 'gt': return v > val; case 'gte': return String(v) >= val; case 'lt': return v < val; case 'lte': return String(v) <= val;
    case 'is': return val === 'null' ? v === null : s === val;
    case 'in': return val.includes(s);
    case 'like': case 'ilike': {
      const re = new RegExp('^' + val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*') + '$', op === 'ilike' ? 'i' : '');
      return v !== null && re.test(s);
    }
    default: throw new Error('op ' + op);
  }
}

function embedsOf(t, select) {
  // alias -> { table, fk, inner }
  const map = {};
  const re = /(?:(\w+):)?(\w+)(!inner)?\(/g;
  let m;
  while ((m = re.exec(select || ''))) {
    const fk = RELATIONS[t] && RELATIONS[t][m[2]];
    if (fk) map[m[1] || m[2]] = { table: m[2], fk, inner: !!m[3] };
  }
  return map;
}
function applyQuery(t, rows, q) {
  let out = rows;
  const embeds = embedsOf(t, q.get('select'));
  for (const [alias, e] of Object.entries(embeds)) {
    if (e.inner && typeof e.fk === 'string') out = out.filter(r => db[e.table].some(x => x.id === r[e.fk]));
  }
  for (const [k, raw] of q) {
    if (['select', 'order', 'offset', 'limit', 'columns'].includes(k)) continue;
    if (k === 'or') {
      const parts = raw.replace(/^\(|\)$/g, '').split(',');
      const conds = parts.map(p => { const [c, op, ...rest] = p.split('.'); return [c, op, rest.join('.')]; });
      for (const [c] of conds) if (!SCHEMA[t].includes(c)) return { error: missingCol(t, c) };
      out = out.filter(r => conds.some(([c, op, v]) => matches(r, c, op, v)));
      continue;
    }
    if (k.includes('.')) {
      const [alias, col] = k.split('.');
      const e = embeds[alias];
      if (!e) return { error: { code: 'PGRST108', message: `'${alias}' is not an embedded resource in this request` } };
      let rest2 = raw; let neg2 = '';
      if (rest2.startsWith('not.')) { neg2 = 'not.'; rest2 = rest2.slice(4); }
      const d2 = rest2.indexOf('.');
      const op2 = rest2.slice(0, d2); const val2 = parseValue(op2, rest2.slice(d2 + 1));
      out = out.filter(r => { const rel = db[e.table].find(x => x.id === r[e.fk]); return rel && matches(rel, col, neg2 + op2, val2); });
      continue;
    }
    if (!SCHEMA[t].includes(k)) return { error: missingCol(t, k) };
    let rest = raw; let neg = '';
    if (rest.startsWith('not.')) { neg = 'not.'; rest = rest.slice(4); }
    const dot = rest.indexOf('.');
    const op = rest.slice(0, dot); const val = parseValue(op, rest.slice(dot + 1));
    out = out.filter(r => matches(r, k, neg + op, val));
  }
  const order = q.get('order');
  if (order) {
    const keys = order.split(',').map(s => s.split('.'));
    for (const [c] of keys) if (!SCHEMA[t].includes(c)) return { error: missingCol(t, c) };
    out = out.slice().sort((a, b) => {
      for (const [c, dir = 'asc', nulls] of keys) {
        const av = a[c], bv = b[c];
        if (av === bv) continue;
        if (av === null) return nulls === 'nullslast' ? 1 : (dir === 'desc' ? -1 : 1);
        if (bv === null) return nulls === 'nullslast' ? -1 : (dir === 'desc' ? 1 : -1);
        const r = av > bv ? 1 : -1;
        return dir === 'desc' ? -r : r;
      }
      return 0;
    });
  }
  return { rows: out };
}
function splitTop(sel) {
  const parts = []; let depth = 0; let cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
function project(t, rows, select) {
  if (!select || select.trim() === '*') return { rows };
  const items = splitTop(select.replace(/\s+/g, ' '));
  const plain = []; const embeds = [];
  for (const it of items) {
    const m = it.match(/^(?:([\w]+):)?([\w]+)(?:!inner)?\((.*)\)$/);
    if (m) {
      const [, alias, table, inner] = m;
      const fk = RELATIONS[t] && RELATIONS[t][table];
      if (!fk) return { error: { code: 'PGRST200', message: `Could not find a relationship between '${t}' and '${table}'` } };
      embeds.push({ key: alias || table, table, fk, inner });
    } else if (it === '*') plain.push(...SCHEMA[t]);
    else plain.push(it);
  }
  for (const c of plain) if (!SCHEMA[t].includes(c)) return { error: missingCol(t, c) };
  const out = [];
  for (const r of rows) {
    const o = Object.fromEntries(plain.map(c => [c, r[c]]));
    for (const e of embeds) {
      if (e.fk && typeof e.fk === 'object' && e.fk.many) {
        const kids = db[e.table].filter(x => x[e.fk.many] === r.id);
        const sub = project(e.table, kids, e.inner);
        if (sub.error) return sub;
        o[e.key] = sub.rows;
        continue;
      }
      const target = db[e.table].find(x => x.id === r[e.fk]);
      if (!target) { o[e.key] = null; continue; }
      const sub = project(e.table, [target], e.inner);
      if (sub.error) return sub;
      o[e.key] = sub.rows[0];
    }
    out.push(o);
  }
  return { rows: out };
}

function respondRows(req, res, t, rows, total, q, status = 200) {
  const p = project(t, rows, q.get('select'));
  if (p.error) return send(res, 400, p.error);
  const single = /vnd\.pgrst\.object/.test(req.headers.accept || '');
  const headers = {};
  if (/count=exact/.test(req.headers.prefer || '')) headers['Content-Range'] = req.method === 'HEAD' ? `*/${total}` : `${rows.length ? (Number(q.get('offset')) || 0) : '*'}-${(Number(q.get('offset')) || 0) + rows.length - 1}/${total}`;
  if (single) {
    if (p.rows.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${p.rows.length} rows` });
    return send(res, status, p.rows[0], headers);
  }
  if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
  if (status === 201 && !/return=representation/.test(req.headers.prefer || '')) { res.writeHead(201, headers); return res.end(); }
  return send(res, status, p.rows, headers);
}

function handleRest(req, res, t, q, body) {
  if (!SCHEMA[t]) return send(res, 404, { code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` });
  const now = new Date().toISOString();
  if (req.method === 'GET' || req.method === 'HEAD') {
    const r = applyQuery(t, db[t], q);
    if (r.error) return send(res, 400, r.error);
    const off = Number(q.get('offset')) || 0;
    const lim = q.has('limit') ? Number(q.get('limit')) : Infinity;
    return respondRows(req, res, t, r.rows.slice(off, off + lim), r.rows.length, q);
  }
  if (req.method === 'POST') {
    const items = Array.isArray(body) ? body : [body];
    for (const it of items) for (const k of Object.keys(it)) if (!SCHEMA[t].includes(k)) return send(res, 400, { code: 'PGRST204', message: `Could not find the '${k}' column of '${t}' in the schema cache` });
    if (t === 'users' && items.some(it => db.users.some(u => u.username === it.username))) return send(res, 409, { code: '23505', message: 'duplicate key value violates unique constraint "users_username_key"' });
    const prefer = req.headers.prefer || '';
    if (UNIQUE[t]) {
      const kept = [];
      for (const it of items) {
        const hit = clash(t, it);
        if (!hit) { kept.push(it); continue; }
        if (prefer.includes('ignore-duplicates')) continue;
        if (prefer.includes('merge-duplicates')) { Object.assign(hit, it); continue; }
        return send(res, 409, { code: '23505', message: 'duplicate key value violates unique constraint' });
      }
      items.length = 0; items.push(...kept);
    }
    const created = items.map((it, idx) => normalise(t, { id: (db[t].length && typeof db[t][0].id === 'number') ? Math.max(0, ...db[t].map(r => r.id)) + 1 + idx : crypto.randomUUID(), created_at: now, updated_at: now, ...it }));
    db[t].push(...created);
    return respondRows(req, res, t, created, created.length, q, 201);
  }
  if (req.method === 'PATCH') {
    for (const k of Object.keys(body)) if (!SCHEMA[t].includes(k)) return send(res, 400, { code: 'PGRST204', message: `Could not find the '${k}' column of '${t}' in the schema cache` });
    const r = applyQuery(t, db[t], q);
    if (r.error) return send(res, 400, r.error);
    r.rows.forEach(row => Object.assign(row, body));
    return respondRows(req, res, t, r.rows, r.rows.length, q);
  }
  if (req.method === 'DELETE') {
    const r = applyQuery(t, db[t], q);
    if (r.error) return send(res, 400, r.error);
    db[t] = db[t].filter(row => !r.rows.includes(row));
    return respondRows(req, res, t, r.rows, r.rows.length, q);
  }
  send(res, 405, { message: 'method' });
}

function handleStorage(req, res, path, buf) {
  let m;
  if ((m = path.match(/^\/storage\/v1\/bucket\/([^/]+)$/)) && req.method === 'GET') {
    return BUCKETS.includes(m[1]) ? send(res, 200, { id: m[1], name: m[1], public: true }) : send(res, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
  }
  if (path === '/storage/v1/bucket' && req.method === 'POST') {
    const { name, id } = JSON.parse(buf.toString() || '{}');
    if (!BUCKETS.includes(name || id)) BUCKETS.push(name || id);
    return send(res, 200, { name: name || id });
  }
  if ((m = path.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/)) && req.method === 'GET') {
    if (m[1] === 'sheroboytech-private') return send(res, 400, { error: 'Bucket is not public' });
    const f = files.get(`${m[1]}/${decodeURIComponent(m[2])}`);
    if (!f) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': f.type, 'Access-Control-Allow-Origin': '*' }); return res.end(f.buf);
  }
  if ((m = path.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/))) {
    if (req.method === 'POST') return send(res, 200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=test-${crypto.randomBytes(6).toString('hex')}` });
    const f = files.get(`${m[1]}/${decodeURIComponent(m[2])}`);
    if (!f) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': f.type }); return res.end(f.buf);
  }
  if ((m = path.match(/^\/storage\/v1\/object\/([^/]+)$/)) && req.method === 'DELETE') {
    const { prefixes } = JSON.parse(buf.toString() || '{}');
    (prefixes || []).forEach(p => files.delete(`${m[1]}/${p}`));
    return send(res, 200, (prefixes || []).map(name => ({ name })));
  }
  if ((m = path.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/)) && (req.method === 'POST' || req.method === 'PUT')) {
    const [, bucket, p] = m;
    if (!BUCKETS.includes(bucket)) return send(res, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    const key = `${bucket}/${decodeURIComponent(p)}`;
    if (files.has(key) && req.headers['x-upsert'] !== 'true') return send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
    files.set(key, { buf, type: req.headers['content-type'] });
    return send(res, 200, { Key: key, Id: crypto.randomUUID() });
  }
  send(res, 404, { error: 'storage route ' + path });
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/rest/v1/')) {
        const body = buf.length && /json/.test(req.headers['content-type'] || '') ? JSON.parse(buf.toString()) : {};
        return handleRest(req, res, url.pathname.slice(9), url.searchParams, body);
      }
      if (url.pathname.startsWith('/storage/v1/')) return handleStorage(req, res, url.pathname, buf);
      if (url.pathname === '/auth/v1/user') {
        const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (tok === 'local-affiliate-admin-token') return send(res, 200, { id: 'admin-user', email: 'admin@local.test', aud: 'authenticated', role: 'authenticated' });
        if (tok === 'local-nonadmin-token') return send(res, 200, { id: 'signup-user', email: 'stranger@local.test', aud: 'authenticated', role: 'authenticated', user_metadata: { role: 'admin' } });
        return send(res, 401, { code: 401, msg: 'invalid JWT' });
      }
      if (url.pathname === '/auth/v1/token') {
        const creds = JSON.parse(buf.toString() || '{}');
        const who = { 'admin@local.test': ['local-affiliate-admin-token', 'admin-user'], 'stranger@local.test': ['local-nonadmin-token', 'signup-user'] }[creds.email];
        if (!who || creds.password !== 'local-test-password') return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return send(res, 200, { access_token: who[0], token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: who[1], email: creds.email, aud: 'authenticated', role: 'authenticated' } });
      }
      if (url.pathname === '/auth/v1/logout' || url.pathname.startsWith('/auth/v1/admin/')) return send(res, 200, {});
      if (url.pathname === '/__db') return send(res, 200, db);
      send(res, 404, { error: 'unknown' });
    } catch (e) { console.error(e); send(res, 500, { message: e.message }); }
  });
}).listen(PORT, () => console.log(`mock supabase on ${PORT} (migrated=${MIGRATED})`));
