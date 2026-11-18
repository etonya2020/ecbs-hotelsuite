'use strict';
// SMS / M-Pesa STK relay: the server calls your gateway, so gateway keys never reach a browser.
const { isCF } = require('./runtime');
// Own IP checks (no node:net), so this file also loads on Cloudflare Workers.
const V4 = /^(0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])(\.(0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])){3}$/;
const net = {
  isIPv4: s => V4.test(String(s)),
  isIPv6: s => { s = String(s); if (!s.includes(':') || /[^0-9a-fA-F:.]/.test(s)) return false; try { new URL('http://[' + s + ']/'); return true; } catch (e) { return false; } },
  isIP(s) { return this.isIPv4(s) ? 4 : this.isIPv6(s) ? 6 : 0; }
};
function v4private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function v6groups(ip) {                        // -> 8 sixteen-bit groups (handles "::" and an embedded dotted IPv4)
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (m) { const q = m[2].split('.').map(Number); ip = m[1] + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16); }
  const [h, t] = ip.split('::'), head = h ? h.split(':') : [], tail = t !== undefined && t ? t.split(':') : [];
  const mid = t === undefined ? [] : new Array(8 - head.length - tail.length).fill('0');
  return [...head, ...mid, ...tail].map(x => parseInt(x || '0', 16));
}
function isPrivate(ip) {
  ip = String(ip).replace(/^\[|\]$/g, '').toLowerCase().split('%')[0];
  if (net.isIPv4(ip)) return v4private(ip);
  if (!net.isIPv6(ip)) return true;                                       // anything we cannot parse is refused
  const g = v6groups(ip), v4 = (x, y) => (x >> 8) + '.' + (x & 255) + '.' + (y >> 8) + '.' + (y & 255);
  if (g.every(x => x === 0) || (g.slice(0, 7).every(x => x === 0) && g[7] === 1)) return true;                 // :: and ::1
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return v4private(v4(g[6], g[7]));                  // IPv4-mapped
  if (g.slice(0, 6).every(x => x === 0)) return v4private(v4(g[6], g[7]));                                     // IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4private(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return v4private(v4(g[1], g[2]));                                                       // 6to4
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}
// Checked again at connection time, so a hostname that later points at an internal address is still refused (DNS rebinding).
function guardedLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  require('dns').lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (process.env.RELAY_ALLOW_PRIVATE !== 'true' && addrs.some(a => isPrivate(a.address))) return cb(new Error('blocked address'));
    opts && opts.all ? cb(null, addrs.map(a => ({ address: a.address, family: a.family }))) : cb(null, addrs[0].address, addrs[0].family);
  });
}
// Cloudflare Workers: plain fetch() (it cannot reach private networks anyway; literal private addresses are still refused below).
async function postFetch(urlStr, headers, payload, { timeout = 15000 } = {}) {
  let u; try { u = new URL(urlStr); } catch (e) { return { ok: false, err: 'Gateway URL is not valid' }; }
  if (u.username || u.password) return { ok: false, err: 'Gateway URL must not contain a password' };
  if (u.protocol !== 'https:') return { ok: false, err: 'Gateway URL must start with https://' };
  const lit = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(lit) && isPrivate(lit) && process.env.RELAY_ALLOW_PRIVATE !== 'true') return { ok: false, err: 'Gateway address is not allowed' };
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(u.toString(), { method: 'POST', redirect: 'manual', signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    const c = r.status; try { await r.body.cancel(); } catch (e) {}
    return { ok: c >= 200 && c < 300, status: c, err: c >= 200 && c < 300 ? '' : c >= 300 && c < 400 ? 'Gateway redirected (not followed)' : 'HTTP ' + c };
  } catch (e) { return { ok: false, err: ctl.signal.aborted ? 'Gateway timed out' : 'Could not reach the gateway' }; }
  finally { clearTimeout(timer); }
}
function post(urlStr, headers, payload, opts = {}) {
  if (isCF) return postFetch(urlStr, headers, payload, opts);
  return postNode(urlStr, headers, payload, opts);
}
function postNode(urlStr, headers, payload, { timeout = 15000, max = 65536 } = {}) {
  const http = require('http'), https = require('https');
  return new Promise(done => {
    let u; try { u = new URL(urlStr); } catch (e) { return done({ ok: false, err: 'Gateway URL is not valid' }); }
    if (u.username || u.password) return done({ ok: false, err: 'Gateway URL must not contain a password' });
    const tls = u.protocol === 'https:';
    if (!tls && !(u.protocol === 'http:' && process.env.RELAY_ALLOW_HTTP === 'true')) return done({ ok: false, err: 'Gateway URL must start with https://' });
    const lit = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(lit) && isPrivate(lit) && process.env.RELAY_ALLOW_PRIVATE !== 'true') return done({ ok: false, err: 'Gateway address is not allowed' });
    const body = JSON.stringify(payload);
    const req = (tls ? https : http).request(u, { method: 'POST', timeout, lookup: guardedLookup, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, r => {
      let n = 0; r.on('data', d => { n += d.length; if (n > max) req.destroy(); });
      r.on('end', () => { const c = r.statusCode; done({ ok: c >= 200 && c < 300, status: c, err: c >= 200 && c < 300 ? '' : c >= 300 && c < 400 ? 'Gateway redirected (not followed)' : 'HTTP ' + c }); });
      r.on('error', () => done({ ok: false, err: 'Gateway connection error' }));
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, err: 'Gateway timed out' }); });
    req.on('error', e => done({ ok: false, err: /blocked address/.test(e.message) ? 'Gateway address is not allowed' : 'Could not reach the gateway' }));
    req.end(body);
  });
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const PHONE = /^\+?\d{7,15}$/;
async function sendSms(cfg, messages) {
  if (!cfg || !cfg.on || !cfg.url) return { error: 'SMS gateway is not set up' };
  const headers = cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {};
  const results = await pool(messages, 4, async m => {
    const to = String(m && m.to || '').replace(/\s+/g, ''), text = String(m && m.message || '');
    if (!PHONE.test(to)) return { ok: false, err: 'Invalid number' };
    if (!text || text.length > 1000) return { ok: false, err: 'Message is empty or too long' };
    const r = await post(cfg.url, headers, { to, message: text, from: cfg.sender, username: cfg.user });
    return { ok: r.ok, err: r.err };
  });
  return { results };
}
async function sendStk(gw, { phone, amount, reference }) {
  if (!gw || !gw.on || !gw.url) return { error: 'STK gateway is not set up' };
  const ph = String(phone || '').replace(/\s+/g, '');
  if (!PHONE.test(ph)) return { error: 'Invalid M-Pesa number' };
  if (!(+amount > 0) || +amount > 250000) return { error: 'Amount must be between 1 and 250,000' };
  const ref = String(reference || '').slice(0, 60);
  const r = await post(gw.url, gw.key ? { Authorization: 'Bearer ' + gw.key } : {}, { phone: ph, amount: +amount, reference: ref, description: 'Payment ' + ref });
  return { ok: r.ok, err: r.err };
}
module.exports = { sendSms, sendStk, isPrivate, post };
