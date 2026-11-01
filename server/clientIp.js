// server/clientIp.js
// The visitor's address for rate limiting and login tracking.
//
// Production traffic reaches the app through Cloudflare, so the address Express
// sees is a Cloudflare edge shared by many visitors. Cloudflare's own
// CF-Connecting-IP header holds the real visitor, but anyone can send that header
// to a server directly, which would let them dodge the limits by changing it. So
// it is believed only when the connection really came from a published Cloudflare
// range (https://www.cloudflare.com/ips/), and Cloudflare overwrites the header
// on every request it forwards.
const net = require('net');

const cloudflare = new net.BlockList();
[
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
].forEach(c => { const [ip, bits] = c.split('/'); cloudflare.addSubnet(ip, Number(bits), 'ipv4'); });
[
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
].forEach(c => { const [ip, bits] = c.split('/'); cloudflare.addSubnet(ip, Number(bits), 'ipv6'); });

function isCloudflare(ip) {
  const family = net.isIP(ip);
  return family ? cloudflare.check(ip, family === 6 ? 'ipv6' : 'ipv4') : false;
}

function clientIp(req) {
  const peer = String(req.ip || '').replace(/^::ffff:/, '');
  const claimed = String(req.get('cf-connecting-ip') || '').trim();
  return claimed && net.isIP(claimed) && isCloudflare(peer) ? claimed : peer;
}

module.exports = { clientIp, isCloudflare };
