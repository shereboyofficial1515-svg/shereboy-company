// A stand-in for Resend's API that keeps to its documented behaviour: idempotency
// keys, batch responses and error shapes. No email ever leaves this process.
const http = require('http');
const crypto = require('crypto');

function startFakeResend() {
  const state = { emails: [], contacts: [], requests: 0, keys: new Map(), mode: 'ok', failTimes: 0, contactCalls: 0, contactsRestricted: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const body = raw ? JSON.parse(raw) : {};
      if (req.url.startsWith('/contacts')) {
        state.contactCalls += 1;
        if (state.contactsRestricted) return send(401, { name: 'restricted_api_key', statusCode: 401, message: 'This API key is restricted to only send emails' });
        if (req.method === 'POST') { state.contacts.push({ ...body }); return send(201, { object: 'contact', id: crypto.randomUUID() }); }
        const email = decodeURIComponent(req.url.split('/')[2] || '');
        const c = state.contacts.find(x => x.email === email || x.id === email);
        if (!c && !body.email) return send(404, { name: 'not_found', statusCode: 404, message: 'Contact not found' });
        if (c) Object.assign(c, body);
        return send(200, { object: 'contact', id: 'x' });
      }
      state.requests += 1;
      const key = req.headers['idempotency-key'];
      if (key && state.keys.has(key)) {
        const seen = state.keys.get(key);
        if (seen.raw !== raw) return send(409, { name: 'invalid_idempotent_request', statusCode: 409, message: 'Same key, different body' });
        return send(200, seen.response);
      }
      const fail = state.failTimes > 0 ? state.mode : 'ok';
      if (state.failTimes > 0) state.failTimes -= 1;
      if (fail === '429') return send(429, { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' });
      if (fail === 'quota') return send(429, { name: 'daily_quota_exceeded', statusCode: 429, message: 'Daily quota exceeded' });
      if (fail === '403') return send(403, { name: 'validation_error', statusCode: 403, message: 'The domain is not verified' });
      if (fail === '500') return send(500, { name: 'application_error', statusCode: 500, message: 'Internal error' });
      const list = Array.isArray(body) ? body : [body];
      const accepted = list.map((m) => ({ id: crypto.randomUUID(), message: m }));
      accepted.forEach(a => state.emails.push({ id: a.id, ...a.message }));
      const response = Array.isArray(body) ? { data: accepted.map(a => ({ id: a.id })) } : { id: accepted[0].id };
      if (key) state.keys.set(key, { raw, response });
      // Accepted, but the reply is lost: exactly the case that causes duplicates
      if (fail === 'lost-reply') return send(500, { name: 'application_error', statusCode: 500, message: 'Reply lost' });
      return send(200, response);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); server.close(); } })));
}

module.exports = { startFakeResend };
