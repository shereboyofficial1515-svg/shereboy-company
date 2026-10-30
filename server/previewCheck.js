// server/previewCheck.js
// Decides whether a project's live website can be shown inside an <iframe>
// on this site. Browsers do not tell the embedding page when a frame was
// refused (X-Frame-Options / CSP frame-ancestors), so we read the target's
// response headers server-side instead of showing a blank or endlessly
// loading preview. We never try to bypass those headers — a refusal simply
// means the visitor gets an "Open in new tab" option.
//
// Only URLs already stored on a project record (entered by an administrator)
// are ever checked; visitors cannot pass arbitrary URLs.

const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 9000;
const cache = new Map(); // url -> { result, at }

function siteOrigins() {
  return (process.env.SITE_URL || 'https://shereboytechltd.site')
    .split(',').map(s => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
}

function analyseHeaders(headers) {
  const xfo = (headers.get('x-frame-options') || '').trim().toLowerCase();
  const csp = headers.get('content-security-policy') || '';
  const match = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp);

  // CSP frame-ancestors overrides X-Frame-Options in modern browsers
  if (match) {
    const sources = match[1].trim().split(/\s+/).map(s => s.toLowerCase());
    if (sources.includes('*')) return { embeddable: true };
    if (sources.includes("'none'")) return { embeddable: false, reason: 'The website does not allow other sites to display it (frame-ancestors \'none\').' };
    const origins = siteOrigins();
    const allowed = sources.some(src => origins.some(o => src === o || (src.startsWith('https://*.') && o.endsWith(src.slice(9)))));
    if (allowed) return { embeddable: true };
    return { embeddable: false, reason: 'The website only allows itself to be displayed on its own domain.' };
  }
  if (xfo === 'deny' || xfo === 'sameorigin') {
    return { embeddable: false, reason: 'The website only allows itself to be displayed on its own domain.' };
  }
  return { embeddable: true };
}

async function checkEmbeddable(url) {
  if (!url) return { embeddable: false, reason: 'No live website address has been added for this project.' };
  // Internal routes on this same application can always be framed
  if (url.startsWith('/') && !url.startsWith('//')) return { embeddable: true, internal: true };

  let parsed;
  try { parsed = new URL(url); } catch { return { embeddable: false, reason: 'The project website address is not valid.' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { embeddable: false, reason: 'The project website address is not valid.' };
  if (siteOrigins().includes(parsed.origin.toLowerCase())) return { embeddable: true, internal: true };
  // http pages cannot be framed inside an https page (mixed content)
  if (parsed.protocol === 'http:') return { embeddable: false, reason: 'The website is not served over a secure (https) connection, so it cannot be previewed here.' };

  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  let result = await probe(url);
  // Hosts that sleep idle apps (e.g. Render free tier) answer 5xx or time out
  // while waking up — give them one more chance before reporting "unknown".
  if (result.embeddable === null) {
    await new Promise(r => setTimeout(r, 2500));
    result = await probe(url);
  }
  if (result.embeddable !== null) cache.set(url, { result, at: Date.now() });
  return result;
}

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SHEREBOY-TECH-Preview-Check/1.0)', Accept: 'text/html' }
    });
    try { await res.body?.cancel(); } catch { /* body not needed */ }
    const verdict = analyseHeaders(res.headers);
    // A refusal header is conclusive even on an error page
    if (verdict.embeddable === false || res.status < 500) return verdict;
    return { embeddable: null, reason: 'The website is not responding normally right now (it may be starting up).' };
  } catch (err) {
    return { embeddable: null, reason: err.name === 'AbortError' ? 'The website is taking a long time to respond (it may be starting up).' : 'The website could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}

function clearPreviewCache(url) { if (url) cache.delete(url); else cache.clear(); }

module.exports = { checkEmbeddable, clearPreviewCache, analyseHeaders };
