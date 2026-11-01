// server/previewCheck.js
// Decides whether a project's live website can be shown inside an <iframe>
// on this site. Browsers do not tell the embedding page when a frame was
// refused (X-Frame-Options / CSP frame-ancestors), so we read the target's
// response headers server-side instead of showing a blank or endlessly
// loading preview. We never try to bypass those headers — a refusal simply
// means the visitor gets an "Open Website" option.
//
// Only URLs already stored on a project record (entered by an administrator)
// are ever checked; visitors cannot pass arbitrary URLs. Even so, this makes an
// outbound request from the server, so every hop is checked against private and
// internal addresses and redirects are followed by hand.

const dns = require('dns').promises;
const net = require('net');

const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 9000;
const MAX_REDIRECTS = 5;
const cache = new Map(); // url -> { result, at }

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([ip, bits]) => blocked.addSubnet(ip, bits, 'ipv4'));
[['::1', 128], ['::', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]].forEach(([ip, bits]) => blocked.addSubnet(ip, bits, 'ipv6'));

function isPrivateAddress(ip) {
  const clean = String(ip).replace(/^::ffff:/i, '');
  const family = net.isIP(clean);
  if (!family) return true;
  return blocked.check(clean, family === 6 ? 'ipv6' : 'ipv4');
}

// Local development may preview local sites; a production server never may.
const allowPrivateTargets = () => process.env.NODE_ENV !== 'production';

async function targetProblem(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return 'The website address is not valid.'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The website address is not valid.';
  if (u.username || u.password) return 'The website address is not valid.';
  if (allowPrivateTargets()) return null;
  if (u.protocol !== 'https:') return 'Only secure (https) websites can be previewed here.';
  if (u.port && u.port !== '443') return 'This website address cannot be previewed.';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPrivateAddress(host) ? 'This website address cannot be previewed.' : null;
  if (/(^|\.)(localhost|local|internal)$/i.test(host)) return 'This website address cannot be previewed.';
  try {
    const addresses = await dns.lookup(host, { all: true });
    if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) return 'This website address cannot be previewed.';
  } catch {
    return 'The website could not be reached.';
  }
  return null;
}

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
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  let result = await probe(url);
  // Free-tier sites can take a moment to wake up: one quick retry before giving up
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
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const problem = await targetProblem(current);
      if (problem) return { embeddable: false, reason: problem };
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SHEREBOY-TECH-Preview-Check/1.0)', Accept: 'text/html' }
      });
      try { await res.body?.cancel(); } catch { /* body not needed */ }
      const verdict = analyseHeaders(res.headers);
      // A refusal on any hop stops the browser too, even on an error page
      if (verdict.embeddable === false) return verdict;
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      if (res.status === 404 || res.status === 410) return { embeddable: false, reason: 'The website returned "page not found" for this address.' };
      if (res.status >= 500) return { embeddable: null, reason: 'The website is not responding normally right now (it may be starting up).' };
      return verdict;
    }
    return { embeddable: false, reason: 'The website redirects too many times to preview here.' };
  } catch (err) {
    return { embeddable: null, reason: err.name === 'AbortError' ? 'The website is taking a long time to respond (it may be starting up).' : 'The website could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}

function clearPreviewCache(url) { if (url) cache.delete(url); else cache.clear(); }

module.exports = { checkEmbeddable, clearPreviewCache, analyseHeaders, isPrivateAddress, targetProblem };
