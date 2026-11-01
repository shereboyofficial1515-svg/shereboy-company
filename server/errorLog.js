// server/errorLog.js
// A small in-memory list of recent server errors for the admin System page.
// It resets on restart and is shown only to administrators. Request bodies,
// headers, cookies and query strings are never recorded, and anything that
// looks like a secret or token is masked before it is stored.
const MAX_ENTRIES = 50;
const entries = [];

const scrub = (text) => String(text == null ? '' : text)
  .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g, '[token]')
  .replace(/\b(?:sk|re|AIza)[-_]?[\w-]{16,}/g, '[key]')
  .replace(/\b(password|secret|token|apikey|api_key)=\S+/gi, '$1=[hidden]')
  .slice(0, 300);

function record(source, message, context = {}) {
  entries.unshift({
    at: new Date().toISOString(),
    source: String(source).slice(0, 40),
    message: scrub(message),
    ...(context.method ? { method: String(context.method).slice(0, 8) } : {}),
    // Path only: query strings can carry user input
    ...(context.path ? { path: scrub(String(context.path).split('?')[0]).slice(0, 120) } : {})
  });
  entries.length = Math.min(entries.length, MAX_ENTRIES);
}

const recent = (limit = 20) => entries.slice(0, limit);

module.exports = { record, recent, scrub };
