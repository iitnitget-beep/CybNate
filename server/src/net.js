'use strict';
/* Outbound HTTP for users' requests. Refuses addresses inside the server's own network unless that is switched on. */
const dns = require('node:dns/promises');
const net = require('node:net');

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
async function check(url, allowPrivate) {
  let u; try { u = new URL(url); } catch (e) { throw Object.assign(new Error('Not a valid address: ' + url), { status: 400 }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw Object.assign(new Error('Only http and https addresses can be called.'), { status: 400 });
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw Object.assign(new Error('Could not find the host ' + host + '.'), { status: 502 }); });
  if (addrs.some((a) => isPrivate(a.address))) throw Object.assign(new Error('That address is inside the server\'s own network and is not allowed.'), { status: 403 });
  return u;
}
/** fetch that checks every hop (redirects included) and stops reading after maxBytes. Returns { status, headers, text, truncated }. */
async function request(o, cfg) {
  let url = o.url, method = (o.method || 'GET').toUpperCase(), body = o.body, res;
  for (let hop = 0; ; hop++) {
    await check(url, cfg.allowPrivate);
    res = await fetch(url, { method, headers: o.headers || {}, body: method === 'GET' || method === 'HEAD' ? undefined : body, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout((o.timeoutSec || 60) * 1000)].concat(o.signal ? [o.signal] : [])) });
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location') || hop >= 5) break;
    const next = new URL(res.headers.get('location'), url);
    // a redirect to another host must not carry the caller's credentials along
    if (next.host !== new URL(url).host) { const h = Object.assign({}, o.headers); Object.keys(h).forEach((k) => { if (/^(authorization|cookie|x-api-key|private-token|apikey)$/i.test(k)) delete h[k]; }); o = Object.assign({}, o, { headers: h }); }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
    url = next.href;
  }
  const max = cfg.maxBytes || 8 * 1024 * 1024, chunks = []; let size = 0, truncated = false;
  if (res.body) for await (const c of res.body) { size += c.length; if (size > max) { truncated = true; break; } chunks.push(c); }
  const headers = {}; res.headers.forEach((v, k) => { if (!/^set-cookie$/i.test(k)) headers[k] = v; });
  return { status: res.status, headers, text: Buffer.concat(chunks).toString('utf8'), truncated, url };
}
module.exports = { isPrivate, check, request };
