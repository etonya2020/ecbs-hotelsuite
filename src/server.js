'use strict';
if (!process.env.TZ) process.env.TZ = 'Africa/Nairobi';          // billing time is the hotel's local time; set TZ for another zone
const http = require('http'), fs = require('fs'), path = require('path');
const db = require('./db'), sec = require('./security'), R = require('./roles'), relay = require('./relay');

/* ---------- configuration (all via environment variables) ---------- */
const PORT = +process.env.PORT || 3000, HOST = process.env.HOST || '0.0.0.0';
const SECURE = process.env.COOKIE_SECURE !== 'false';                    // keep true behind HTTPS (default)
const COOKIE = (SECURE ? '__Host-' : '') + 'ecbs_sid';
const IDLE = (+process.env.SESSION_IDLE_MIN || 30) * 60000, MAXS = (+process.env.SESSION_MAX_HOURS || 12) * 3600000;
const TRUST = process.env.TRUST_PROXY === 'true';
const BODY_MAX = (+process.env.BODY_MAX_MB || 10) * 1048576, IMPORT_MAX = (+process.env.IMPORT_MAX_MB || 60) * 1048576;
const MAX_REC = 2 * 1048576, MAX_OPS = 1000;
const HISTORY = process.env.HISTORY !== 'off';
const MAXFAIL = +process.env.LOGIN_MAX_FAILS || 5, IP_MAXFAIL = +process.env.IP_MAX_FAILS || 50, LOGIN_RATE = +process.env.LOGIN_RATE_MAX || 100, LOCK_MS = (+process.env.LOGIN_LOCK_MIN || 15) * 60000;
const kv = s => Object.fromEntries(String(s || '').split(',').map(x => x.trim().split('=')).filter(x => x[0] && x[1]));
const TENANT_MAP = kv(process.env.TENANT_MAP), ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' " + (process.env.CSP_CONNECT || '') + "; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()', 'Content-Security-Policy': CSP,
  ...(SECURE ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
};
const NAME_RE = /^(obj:)?[a-z][a-z0-9_]{0,38}$/, ID_RE = /^[A-Za-z0-9_\-:.]{1,80}$/, USER_RE = /^[a-z0-9._-]{3,32}$/;

/* ---------- small helpers ---------- */
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const log = o => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const ipOf = req => { if (TRUST) { const x = req.headers['x-forwarded-for']; if (x) return String(x).split(',')[0].trim(); } return req.socket.remoteAddress || ''; };
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(body == null ? '' : JSON.stringify(body));
};
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => { const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]; }));
const setCookie = (val, maxAge) => `${COOKIE}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Strict${SECURE ? '; Secure' : ''}; Max-Age=${maxAge}`;
function readBody(req, limit) {
  return new Promise((ok, bad) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > limit) { bad(new HttpError(413, 'Request too large')); req.destroy(); return; } c.push(d); });
    req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}); } catch (e) { bad(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', bad);
  });
}
const hits = new Map();
function rate(key, max, win) {
  const now = Date.now(); let h = hits.get(key);
  if (!h || now - h.t > win) h = { t: now, n: 0 };
  h.n++; hits.set(key, h);
  return h.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 600000) hits.delete(k); }, 60000).unref();
const hostOf = req => String((TRUST && req.headers['x-forwarded-host']) || req.headers.host || '').split(':')[0].toLowerCase();
async function tenantFor(req) {
  const r = await platform.resolveHost(hostOf(req));
  if (r.platform) throw new HttpError(404, 'Not found');
  if (r.unknown) throw new HttpError(404, 'This organisation address is not active. Check the web address or contact Ettylinks.');
  return r.tid;
}
function originOk(req) {
  const o = req.headers.origin; if (!o) return true;
  if (ORIGINS.includes(o)) return true;
  try { return new URL(o).host === String((TRUST && req.headers['x-forwarded-host']) || req.headers.host); } catch (e) { return false; }
}
async function audit(tid, who, action, detail, ip) {
  try { await db.q('INSERT INTO audit_log(ts,tenant_id,user_name,action,detail,ip) VALUES(?,?,?,?,?,?)', [Date.now(), tid, who || null, action, detail ? String(detail).slice(0, 1000) : null, ip || null]); }
  catch (e) { log({ level: 'error', msg: 'audit failed', err: e.message }); }
}

/* ---------- tenants & roles ---------- */
const known = new Set(), roleCache = new Map();
async function ensureTenant(tid) {
  if (known.has(tid)) return;
  const r = await db.q('SELECT id FROM tenants WHERE id=?', [tid]);
  if (!r.length) await db.q('INSERT INTO tenants(id,name,rev,created_at) VALUES(?,?,0,?)', [tid, tid, Date.now()]);
  await seedLicense(tid);
  known.add(tid);
}
// The licence record is created by the SERVER the first time a site is used, so the 30-day trial clock cannot be restarted from a browser.
async function seedLicense(tid) {
  if ((await db.q("SELECT 1 AS x FROM records WHERE tenant_id=? AND coll='obj:lic' AND rid='main'", [tid])).length) return;
  const data = { status: 'Active', plan: 'Trial', fee: 0, mode: '', expiry: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), key: '', org: '', contact: '', phone: '', email: '', addr: '', reg: false, regAt: '', lastPay: '', grace: 7, updUrl: '', pays: [] };
  await db.tx(async t => {
    const rev = Number((await t.q('UPDATE tenants SET rev=rev+1 WHERE id=? RETURNING rev', [tid]))[0].rev);
    await t.q("INSERT INTO records(tenant_id,coll,rid,kind,seq,data,ver,deleted,rev,updated_by,updated_at) VALUES(?,'obj:lic','main','obj',?,?,1,0,?,'system',?)", [tid, rev, JSON.stringify(data), rev, Date.now()]);
  });
}
async function getRoles(tid) {
  if (roleCache.has(tid)) return roleCache.get(tid);
  let rows = await db.q('SELECT name,write_rules,hr_access FROM roles WHERE tenant_id=?', [tid]);
  if (!rows.length) {
    for (const [n, v] of Object.entries(R.DEFAULTS)) await db.q('INSERT INTO roles(tenant_id,name,write_rules,hr_access) VALUES(?,?,?,?)', [tid, n, JSON.stringify(v.write), v.hr ? 1 : 0]);
    rows = await db.q('SELECT name,write_rules,hr_access FROM roles WHERE tenant_id=?', [tid]);
  }
  const roles = {}; rows.forEach(r => { roles[r.name] = { write: JSON.parse(r.write_rules), hr: !!r.hr_access }; });
  roleCache.set(tid, roles); return roles;
}

/* ---------- reading data (with redaction) ---------- */
const HIDE = Symbol('hide'), MASK = '********';
function mapSecret(coll, d, fn) {
  const ps = R.SECRETS[coll]; if (!ps) return d;
  d = JSON.parse(JSON.stringify(d));
  for (const p of ps) {
    const parts = p.split('.'); let o = d;
    for (let i = 0; i < parts.length - 1 && o; i++) o = o[parts[i]];
    const k = parts[parts.length - 1];
    if (o && typeof o[k] === 'string' && o[k] !== '') o[k] = fn(o[k]);
  }
  return d;
}
function outRecord(role, roles, coll, d, pins) {
  const admin = R.isAdminRole(role);
  if (coll === 'audit' && !admin) return HIDE;
  d = mapSecret(coll, d, () => MASK);                                       // gateway keys are never sent to any browser, not even an administrator's
  if (coll === 'staff') {
    d = { ...d }; delete d.pinh;                                            // PIN hashes stay on the server; the screen only learns whether a PIN exists
    if (pins && pins.has(String(d.id))) d.pinh = 'set';
    if (!(roles[role] && roles[role].hr)) { if ('salary' in d) d.salary = 0; d._redacted = 1; }
  }
  return d;
}
const pinSet = async tid => new Set((await db.q('SELECT staff_id FROM staff_pins WHERE tenant_id=?', [tid])).map(r => r.staff_id));
function getPath(o, p) { for (const k of p.split('.')) { if (o == null) return undefined; o = o[k]; } return o; }
function setPath(o, p, v) { const a = p.split('.'); for (let i = 0; i < a.length - 1; i++) { if (o[a[i]] == null || typeof o[a[i]] !== 'object') o[a[i]] = {}; o = o[a[i]]; } o[a[a.length - 1]] = v; }
function keepSecrets(coll, data, existingJson) {   // a masked value means "leave the stored key as it is"
  const ps = R.SECRETS[coll]; if (!ps) return data;
  data = JSON.parse(JSON.stringify(data)); const old = existingJson ? JSON.parse(existingJson) : {};
  for (const p of ps) if (getPath(data, p) === MASK) setPath(data, p, getPath(old, p) || '');
  return data;
}
async function loadState(user) {
  const roles = await getRoles(user.tenant), pins = await pinSet(user.tenant);
  const rev = (await db.q('SELECT rev FROM tenants WHERE id=?', [user.tenant]))[0].rev;
  const rows = await db.q('SELECT coll,rid,kind,data,ver FROM records WHERE tenant_id=? AND deleted=0 ORDER BY coll,seq', [user.tenant]);
  const cols = {};
  for (const r of rows) {
    const c = cols[r.coll] || (cols[r.coll] = { kind: r.kind, records: [] });
    const d = outRecord(user.role, roles, r.coll, JSON.parse(r.data), pins);
    if (d !== HIDE) c.records.push({ id: r.rid, ver: r.ver, data: d });
  }
  return { rev, empty: rows.every(r => r.coll === 'obj:lic'), collections: cols };
}

/* ---------- developer platform (packages, clients, licensing) ---------- */
const platform = require('./platform')({ db, sec, HttpError, send, audit, ensureTenant, getRoles, dropRoles: tid => roleCache.delete(tid), cookies, ipOf, rate, readBody, originOk, SECURE, MAXS, IDLE, attemptState, failAttempt, SEC_HEADERS, TENANT_MAP, log });

/* ---------- writing data ---------- */
async function licenseBlocked(t, tid) {
  const r = (await t.q("SELECT data FROM records WHERE tenant_id=? AND coll='obj:lic' AND rid='main' AND deleted=0", [tid]))[0];
  if (!r) return false;
  let L; try { L = JSON.parse(r.data); } catch (e) { return false; }
  if (L.status === 'Deactivated') return true;
  if (L.expiry) { const lim = new Date(L.expiry + 'T00:00:00Z').getTime() + ((+L.grace || 0) + 1) * 86400000; if (Date.now() > lim) return true; }
  return false;
}
// Staff records never keep a PIN hash. A legacy hash from the old browser-only version is moved into the server-only PIN table.
async function prepStaff(t, tid, data, hr) {
  if (!('pinh' in data)) return data;
  const h = data.pinh; data = { ...data }; delete data.pinh;
  if (hr && typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) && data.id != null)
    await t.q('INSERT INTO staff_pins(tenant_id,staff_id,pin_hash,legacy,fails,locked_until,updated_at) VALUES(?,?,?,1,0,0,?) ON CONFLICT(tenant_id,staff_id) DO NOTHING', [tid, String(data.id), h, Date.now()]);
  return data;
}
async function applyOne(t, ctx, roles, op, rev, locked, ts) {
  const user = ctx.user, tid = user.tenant;
  const bad = (err, extra) => ({ c: op && op.c, id: op && op.id, ok: false, err, ...extra });
  if (!op || typeof op.c !== 'string' || !NAME_RE.test(op.c) || typeof op.id !== 'string' || !ID_RE.test(op.id)) return bad('invalid');
  const isObj = op.c.startsWith('obj:'); if (isObj && op.id !== 'main') return bad('invalid');
  const ex = (await t.q('SELECT data,ver,deleted FROM records WHERE tenant_id=? AND coll=? AND rid=?', [tid, op.c, op.id]))[0];
  const live = ex && !ex.deleted;
  const cur = () => live ? { data: (d => d === HIDE ? null : d)(outRecord(user.role, roles, op.c, JSON.parse(ex.data), ctx.pins)), ver: ex.ver } : null;
  const del = !!op.del;
  const perm = R.canWrite(user.role, roles, op.c, { del, exists: !!live });
  if (!perm.ok) return bad('forbidden', { current: cur() });
  if (locked && user.role !== R.DEV) return bad('license', { current: cur() });
  const offBy = platform.collBlocked(ctx.plan, op.c); if (offBy) return bad('module', { module: offBy, current: cur() });
  const hist = async (name, ver, data) => { if (HISTORY) await t.q('INSERT INTO history(tenant_id,coll,rid,ver,op,data,by_user,ts) VALUES(?,?,?,?,?,?,?,?)', [tid, op.c, op.id, ver, name, data, user.name, ts]); };
  if (del) {
    if (!live) return { c: op.c, id: op.id, ok: true, ver: ex ? ex.ver : 0, gone: true };
    if (op.ver != null && op.ver !== ex.ver) return bad('conflict', { current: cur() });
    await t.q('UPDATE records SET deleted=1, ver=ver+1, rev=?, updated_by=?, updated_at=? WHERE tenant_id=? AND coll=? AND rid=?', [rev, user.name, ts, tid, op.c, op.id]);
    if (op.c === 'staff') { try { await t.q('DELETE FROM staff_pins WHERE tenant_id=? AND staff_id=?', [tid, String(JSON.parse(ex.data).id)]); } catch (e) {} }
    await hist('delete', ex.ver + 1, ex.data);
    return { c: op.c, id: op.id, ok: true, ver: ex.ver + 1, deleted: true };
  }
  let data = op.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || sec.unsafe(data)) return bad('invalid');
  if (op.c === 'staff') data = await prepStaff(t, tid, data, !!(roles[user.role] && roles[user.role].hr));
  if (op.c === 'mpu') {
    if (typeof data.amt !== 'number' || !(data.amt > 0) || typeof data.ref !== 'string' || !data.ref || !['Customer', 'Internal', 'Matched'].includes(data.tag)) return bad('invalid');
    if (!live) for (const r of await t.q("SELECT rid,data FROM records WHERE tenant_id=? AND coll='mpu' AND deleted=0 AND data LIKE ?", [tid, '%' + JSON.stringify('ref') + ':' + JSON.stringify(data.ref) + '%'])) { try { if (JSON.parse(r.data).ref === data.ref && r.rid !== op.id) return bad('duplicate'); } catch (e) {} }
  }
  data = keepSecrets(op.c, data, live ? ex.data : null);
  const stored = JSON.stringify(mapSecret(op.c, data, sec.encrypt));
  if (stored.length > MAX_REC) return bad('too_large');
  if (live && (stored === ex.data || (R.SECRETS[op.c] && JSON.stringify(mapSecret(op.c, JSON.parse(ex.data), sec.decrypt)) === JSON.stringify(data)))) return { c: op.c, id: op.id, ok: true, ver: ex.ver, same: true };   // idempotent retry
  if (!ex) {
    await t.q('INSERT INTO records(tenant_id,coll,rid,kind,seq,data,ver,deleted,rev,updated_by,updated_at) VALUES(?,?,?,?,?,?,1,0,?,?,?)', [tid, op.c, op.id, isObj ? 'obj' : 'arr', rev, stored, rev, user.name, ts]);
    await hist('insert', 1, stored); return { c: op.c, id: op.id, ok: true, ver: 1 };
  }
  if (!live) {
    if (op.ver != null) return bad('conflict', { current: null });
    await t.q('UPDATE records SET data=?, ver=ver+1, deleted=0, seq=?, rev=?, updated_by=?, updated_at=? WHERE tenant_id=? AND coll=? AND rid=?', [stored, rev, rev, user.name, ts, tid, op.c, op.id]);
    await hist('insert', ex.ver + 1, stored); return { c: op.c, id: op.id, ok: true, ver: ex.ver + 1 };
  }
  if (op.ver !== ex.ver) return bad('conflict', { current: cur() });
  await t.q('UPDATE records SET data=?, ver=ver+1, rev=?, updated_by=?, updated_at=? WHERE tenant_id=? AND coll=? AND rid=?', [stored, rev, user.name, ts, tid, op.c, op.id]);
  await hist('update', ex.ver + 1, stored); return { c: op.c, id: op.id, ok: true, ver: ex.ver + 1 };
}
async function applySync(ctx, ops) {
  if (!Array.isArray(ops) || ops.length > MAX_OPS) throw new HttpError(400, 'Too many operations in one request');
  const tid = ctx.user.tenant, roles = await getRoles(tid), ts = Date.now();
  ctx.pins = await pinSet(tid); ctx.plan = await platform.planFor(tid);
  const out = await db.tx(async t => {
    const locked = await licenseBlocked(t, tid);
    const rev = (await t.q('UPDATE tenants SET rev=rev+? WHERE id=? RETURNING rev', [Math.max(ops.length, 1), tid]))[0].rev - ops.length;
    const res = []; let i = 0;
    for (const op of ops) res.push(await applyOne(t, ctx, roles, op, rev + (++i), locked, ts));
    return { results: res, rev: rev + ops.length };
  });
  const denied = out.results.filter(r => !r.ok && (r.err === 'forbidden' || r.err === 'license' || r.err === 'module'));
  const dels = out.results.filter(r => r.ok && r.deleted);
  if (denied.length) await audit(tid, ctx.user.name, 'write_denied', denied.slice(0, 10).map(r => r.c + ':' + r.err).join(', '), ctx.ip);
  if (dels.length) await audit(tid, ctx.user.name, 'delete', dels.length + ' record(s): ' + [...new Set(dels.map(r => r.c))].slice(0, 10).join(', '), ctx.ip);
  return out;
}

/* ---------- authentication ---------- */
async function authenticate(req) {
  const ck = cookies(req)[COOKIE]; if (!ck) return null;
  const sid = sec.sha(ck);
  const r = (await db.q('SELECT s.csrf,s.expires_at,s.last_seen,u.id uid,u.tenant_id,u.username,u.display,u.role,u.active,u.must_change FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?', [sid]))[0];
  if (!r) return null;
  const now = Date.now();
  if (r.expires_at < now || now - r.last_seen > IDLE || !r.active) { await db.q('DELETE FROM sessions WHERE id=?', [sid]); return null; }
  if (!req.headers['x-background'] && now - r.last_seen > 30000) await db.q('UPDATE sessions SET last_seen=? WHERE id=?', [now, sid]);   // background polls do not keep a session alive
  return { sid, csrf: r.csrf, ip: ipOf(req), user: { id: r.uid, tenant: r.tenant_id, name: r.username, display: r.display || r.username, role: r.role, must_change: !!r.must_change } };
}
async function attemptState(key) {
  const r = (await db.q('SELECT n,first_at,locked_until FROM login_attempts WHERE k=?', [key]))[0];
  return r || { n: 0, first_at: 0, locked_until: 0 };
}
async function failAttempt(key, max) {
  const now = Date.now(), s = await attemptState(key);
  let n = s.n + 1, first = s.first_at, lock = 0;
  if (!s.first_at || now - s.first_at > LOCK_MS) { n = 1; first = now; }
  if (n >= max) lock = now + LOCK_MS;
  await db.q('INSERT INTO login_attempts(k,n,first_at,locked_until) VALUES(?,?,?,?) ON CONFLICT(k) DO UPDATE SET n=excluded.n, first_at=excluded.first_at, locked_until=excluded.locked_until', [key, n, first, lock]);
}
let DUMMY = null;
async function newSession(user, req) {
  const tok = sec.token(), now = Date.now(), csrf = sec.token();
  await db.q('INSERT INTO sessions(id,user_id,tenant_id,csrf,created_at,last_seen,expires_at,ip,ua) VALUES(?,?,?,?,?,?,?,?,?)', [sec.sha(tok), user.id, user.tenant_id, csrf, now, now, now + MAXS, ipOf(req), String(req.headers['user-agent'] || '').slice(0, 200)]);
  const old = await db.q('SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC', [user.id]);
  for (const o of old.slice(10)) await db.q('DELETE FROM sessions WHERE id=?', [o.id]);
  return { tok, csrf };
}
const pub = u => ({ name: u.name, display: u.display, role: u.role, must_change: u.must_change, admin: R.isAdminRole(u.role), dev: u.role === R.DEV });

/* ---------- route handlers ---------- */
const H = {};
H['POST /api/login'] = async (req, res, ctx, body, tid) => {
  const username = String(body.username || '').trim().toLowerCase(), password = String(body.password || ''), ip = ipOf(req);
  if (!rate('login:' + ip, LOGIN_RATE, 300000)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const keys = ['u:' + tid + ':' + username, 'ip:' + ip];
  for (const k of keys) { const s = await attemptState(k); if (s.locked_until > Date.now()) { res.setHeader('Retry-After', Math.ceil((s.locked_until - Date.now()) / 1000)); throw new HttpError(429, 'Account temporarily locked after repeated failures. Try again later or ask an administrator to unlock it.'); } }
  const u = (await db.q('SELECT id,tenant_id,username,display,role,pw_hash,active,must_change FROM users WHERE tenant_id=? AND username=?', [tid, username]))[0];
  if (!DUMMY) DUMMY = await sec.hashPw('dummy-password-for-timing');
  const ok = await sec.verifyPw(password, u && u.pw_hash ? u.pw_hash : DUMMY) && u && u.active && u.pw_hash;
  if (!ok) { await failAttempt(keys[0], MAXFAIL); await failAttempt(keys[1], IP_MAXFAIL); await audit(tid, username || null, 'login_failed', null, ip); throw new HttpError(401, 'Invalid username or password'); }
  await db.q('DELETE FROM login_attempts WHERE k=?', [keys[0]]);
  const s = await newSession(u, req);
  await db.q('UPDATE users SET last_login=? WHERE id=?', [Date.now(), u.id]);
  await audit(tid, u.username, 'login', null, ip);
  const user = { name: u.username, display: u.display || u.username, role: u.role, must_change: !!u.must_change };
  send(res, 200, { user: pub(user), csrf: s.csrf, plan: await platform.publicPlan(tid) }, { 'Set-Cookie': setCookie(s.tok, MAXS / 1000) });
};
H['POST /api/logout'] = async (req, res, ctx) => {
  await db.q('DELETE FROM sessions WHERE id=?', [ctx.sid]); await audit(ctx.user.tenant, ctx.user.name, 'logout', null, ctx.ip);
  send(res, 200, { ok: true }, { 'Set-Cookie': setCookie('', 0) });
};
H['GET /api/me'] = async (req, res, ctx) => send(res, 200, { user: pub(ctx.user), csrf: ctx.csrf, plan: await platform.publicPlan(ctx.user.tenant) });
H['POST /api/change-password'] = async (req, res, ctx, body) => {
  const u = (await db.q('SELECT id,pw_hash FROM users WHERE id=?', [ctx.user.id]))[0];
  if (!(await sec.verifyPw(String(body.old || ''), u.pw_hash))) { await audit(ctx.user.tenant, ctx.user.name, 'password_change_failed', null, ctx.ip); throw new HttpError(400, 'Current password is wrong'); }
  const bad = sec.pwPolicy(String(body.new || ''), ctx.user.name); if (bad) throw new HttpError(400, bad);
  if (body.new === body.old) throw new HttpError(400, 'Choose a different password');
  await db.q('UPDATE users SET pw_hash=?, must_change=0, pw_changed_at=? WHERE id=?', [await sec.hashPw(body.new), Date.now(), u.id]);
  await db.q('DELETE FROM sessions WHERE user_id=? AND id<>?', [u.id, ctx.sid]);
  await audit(ctx.user.tenant, ctx.user.name, 'password_changed', null, ctx.ip);
  send(res, 200, { ok: true });
};
H['GET /api/state'] = async (req, res, ctx) => {
  const st = await loadState(ctx.user);
  const users = (await db.q('SELECT username,display,role FROM users WHERE tenant_id=? AND active=1 ORDER BY username', [ctx.user.tenant])).map(x => ({ name: x.username, display: x.display || x.username, role: x.role }));
  send(res, 200, { ...st, users, roles: Object.keys(await getRoles(ctx.user.tenant)) });
};
H['POST /api/sync'] = async (req, res, ctx, body) => send(res, 200, await applySync(ctx, body.ops));
H['GET /api/changes'] = async (req, res, ctx, body, tid, url) => {
  const since = +url.searchParams.get('since') || 0, roles = await getRoles(tid), pins = await pinSet(tid);
  const cur = (await db.q('SELECT rev FROM tenants WHERE id=?', [tid]))[0].rev;
  if (since > cur) return send(res, 200, { reset: true, rev: cur });
  const rows = await db.q('SELECT coll,rid,kind,data,ver,deleted,rev FROM records WHERE tenant_id=? AND rev>? ORDER BY rev LIMIT 1000', [tid, since]);
  const changes = [];
  for (const r of rows) {
    if (r.deleted) { changes.push({ c: r.coll, id: r.rid, k: r.kind, ver: r.ver, deleted: true }); continue; }
    const d = outRecord(ctx.user.role, roles, r.coll, JSON.parse(r.data), pins);
    if (d !== HIDE) changes.push({ c: r.coll, id: r.rid, k: r.kind, ver: r.ver, data: d });
  }
  const more = rows.length === 1000;
  send(res, 200, { rev: more ? rows[rows.length - 1].rev : Math.max(cur, since), more, changes });
};
H['POST /api/numbers/next'] = async (req, res, ctx, body, tid) => {
  const p = String(body.prefix || ''); if (!/^[A-Za-z]{1,6}$/.test(p)) throw new HttpError(400, 'Bad prefix');
  const r = await db.q('INSERT INTO sequences(tenant_id,prefix,n) VALUES(?,?,1) ON CONFLICT(tenant_id,prefix) DO UPDATE SET n=sequences.n+1 RETURNING n', [tid, p]);
  send(res, 200, { n: Number(r[0].n) });
};
H['GET /api/numbers'] = async (req, res, ctx, body, tid) => send(res, 200, { counters: Object.fromEntries((await db.q('SELECT prefix,n FROM sequences WHERE tenant_id=?', [tid])).map(x => [x.prefix, Number(x.n)])) });
H['POST /api/numbers/init'] = async (req, res, ctx, body, tid) => {
  if (!R.isAdminRole(ctx.user.role)) throw new HttpError(403, 'Administrators only');
  const c = body.counters && typeof body.counters === 'object' ? body.counters : {}; let n = 0;
  for (const [p, v] of Object.entries(c)) if (/^[A-Za-z]{1,6}$/.test(p) && Number.isFinite(+v) && +v >= 0) {
    await db.q('INSERT INTO sequences(tenant_id,prefix,n) VALUES(?,?,?) ON CONFLICT(tenant_id,prefix) DO UPDATE SET n=CASE WHEN excluded.n>sequences.n THEN excluded.n ELSE sequences.n END', [tid, p, Math.floor(+v)]); n++;
  }
  send(res, 200, { ok: true, set: n });
};
/* --- administration --- */
const needAdmin = ctx => { if (!R.isAdminRole(ctx.user.role)) throw new HttpError(403, 'Administrators only'); };
const needDev = ctx => { if (ctx.user.role !== R.DEV) throw new HttpError(403, 'Developer only'); };
const urow = u => ({ id: u.id, username: u.username, display: u.display || '', role: u.role, active: !!u.active, must_change: !!u.must_change, last_login: u.last_login, locked: false });
async function activeAdmins(tid, exceptId) {
  return Number((await db.q("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND active=1 AND role IN ('Admin','Developer Super Admin') AND id<>?", [tid, exceptId || '']))[0].c);
}
H['GET /api/admin/users'] = async (req, res, ctx, body, tid) => {
  needAdmin(ctx);
  const rows = await db.q('SELECT id,username,display,role,active,must_change,last_login FROM users WHERE tenant_id=? ORDER BY username', [tid]);
  const out = [];
  for (const u of rows) { const x = urow(u); x.locked = (await attemptState('u:' + tid + ':' + u.username)).locked_until > Date.now(); out.push(x); }
  send(res, 200, { users: out, roles: Object.keys(await getRoles(tid)) });
};
H['POST /api/admin/users'] = async (req, res, ctx, body, tid) => {
  needAdmin(ctx); const roles = await getRoles(tid);
  const username = String(body.username || '').trim().toLowerCase();
  if (!USER_RE.test(username)) throw new HttpError(400, 'Username: 3-32 letters, numbers, dot, dash or underscore');
  if (!roles[body.role]) throw new HttpError(400, 'Unknown role');
  if (body.role === R.DEV && ctx.user.role !== R.DEV) throw new HttpError(403, 'Only the developer can create developer accounts');
  if ((await db.q('SELECT id FROM users WHERE tenant_id=? AND username=?', [tid, username])).length) throw new HttpError(409, 'That username already exists');
  await platform.checkUserCap(tid);
  let pw = body.password, temp = null;
  if (pw) { const bad = sec.pwPolicy(pw, username); if (bad) throw new HttpError(400, bad); } else { pw = temp = sec.randomPassword(); }
  const id = sec.uuid();
  await db.q('INSERT INTO users(id,tenant_id,username,display,role,pw_hash,active,must_change,created_at) VALUES(?,?,?,?,?,?,1,1,?)', [id, tid, username, String(body.display || '').slice(0, 80) || null, body.role, await sec.hashPw(pw), Date.now()]);
  await audit(tid, ctx.user.name, 'user_created', username + ' (' + body.role + ')', ctx.ip);
  send(res, 201, { id, username, role: body.role, temp_password: temp });
};
H['PUT /api/admin/users/:id'] = async (req, res, ctx, body, tid, url, params) => {
  needAdmin(ctx); const roles = await getRoles(tid);
  const u = (await db.q('SELECT * FROM users WHERE tenant_id=? AND id=?', [tid, params.id]))[0]; if (!u) throw new HttpError(404, 'No such user');
  if (u.role === R.DEV && ctx.user.role !== R.DEV) throw new HttpError(403, 'Only the developer can change developer accounts');
  const self = u.id === ctx.user.id, sets = [], vals = [], notes = []; let temp = null, kill = false;
  if (body.display !== undefined) { sets.push('display=?'); vals.push(String(body.display).slice(0, 80) || null); }
  if (body.role !== undefined && body.role !== u.role) {
    if (!roles[body.role]) throw new HttpError(400, 'Unknown role');
    if (self) throw new HttpError(400, 'You cannot change your own role');
    if (body.role === R.DEV && ctx.user.role !== R.DEV) throw new HttpError(403, 'Only the developer can grant that role');
    if (R.isAdminRole(u.role) && !R.isAdminRole(body.role) && (await activeAdmins(tid, u.id)) < 1) throw new HttpError(400, 'At least one administrator must remain');
    sets.push('role=?'); vals.push(body.role); notes.push('role=' + body.role); kill = true;
  }
  if (body.active !== undefined && !!body.active !== !!u.active) {
    if (!body.active) { if (self) throw new HttpError(400, 'You cannot deactivate yourself'); if (R.isAdminRole(u.role) && (await activeAdmins(tid, u.id)) < 1) throw new HttpError(400, 'At least one administrator must remain'); kill = true; }
    sets.push('active=?'); vals.push(body.active ? 1 : 0); notes.push(body.active ? 'activated' : 'deactivated');
  }
  if (body.reset_password || body.new_password) {
    let pw = body.new_password; if (pw) { const bad = sec.pwPolicy(pw, u.username); if (bad) throw new HttpError(400, bad); } else { pw = temp = sec.randomPassword(); }
    sets.push('pw_hash=?', 'must_change=1', 'pw_changed_at=?'); vals.push(await sec.hashPw(pw), Date.now()); notes.push('password reset'); kill = true;
  }
  if (body.unlock) { await db.q('DELETE FROM login_attempts WHERE k=?', ['u:' + tid + ':' + u.username]); notes.push('unlocked'); }
  if (sets.length) await db.q(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, [...vals, u.id]);
  if (kill) await db.q('DELETE FROM sessions WHERE user_id=?', [u.id]);
  await audit(tid, ctx.user.name, 'user_updated', u.username + ': ' + (notes.join(', ') || 'no change'), ctx.ip);
  send(res, 200, { ok: true, temp_password: temp });
};
H['DELETE /api/admin/users/:id'] = async (req, res, ctx, body, tid, url, params) => {
  needAdmin(ctx);
  const u = (await db.q('SELECT * FROM users WHERE tenant_id=? AND id=?', [tid, params.id]))[0]; if (!u) throw new HttpError(404, 'No such user');
  if (u.id === ctx.user.id) throw new HttpError(400, 'You cannot delete yourself');
  if (u.role === R.DEV && ctx.user.role !== R.DEV) throw new HttpError(403, 'Only the developer can delete developer accounts');
  if (R.isAdminRole(u.role) && (await activeAdmins(tid, u.id)) < 1) throw new HttpError(400, 'At least one administrator must remain');
  await db.q('DELETE FROM sessions WHERE user_id=?', [u.id]); await db.q('DELETE FROM users WHERE id=?', [u.id]);
  await audit(tid, ctx.user.name, 'user_deleted', u.username, ctx.ip); send(res, 200, { ok: true });
};
H['GET /api/admin/sessions'] = async (req, res, ctx, body, tid) => {
  needAdmin(ctx);
  const rows = await db.q('SELECT s.id,u.username,s.ip,s.created_at,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.tenant_id=? ORDER BY s.last_seen DESC', [tid]);
  send(res, 200, { sessions: rows.map(r => ({ id: r.id.slice(0, 16), username: r.username, ip: r.ip, created_at: r.created_at, last_seen: r.last_seen, current: r.id === ctx.sid })) });
};
H['DELETE /api/admin/sessions/:id'] = async (req, res, ctx, body, tid, url, params) => {
  needAdmin(ctx);
  const rows = await db.q('SELECT id FROM sessions WHERE tenant_id=? AND id LIKE ?', [tid, String(params.id).replace(/[^a-f0-9]/g, '') + '%']);
  if (rows.length !== 1) throw new HttpError(404, 'No such session');
  await db.q('DELETE FROM sessions WHERE id=?', [rows[0].id]); await audit(tid, ctx.user.name, 'session_revoked', params.id, ctx.ip); send(res, 200, { ok: true });
};
H['GET /api/admin/audit'] = async (req, res, ctx, body, tid, url) => {
  needAdmin(ctx);
  const lim = Math.min(+url.searchParams.get('limit') || 200, 1000), before = +url.searchParams.get('before') || 9e15;
  const a = url.searchParams.get('action'), w = [], p = [tid, before];
  let sql = 'SELECT id,ts,user_name,action,detail,ip FROM audit_log WHERE tenant_id=? AND id<?';
  if (a) { sql += ' AND action=?'; p.push(a); }
  send(res, 200, { rows: await db.q(sql + ' ORDER BY id DESC LIMIT ' + lim, p) });
};
H['GET /api/admin/history'] = async (req, res, ctx, body, tid, url) => {
  needAdmin(ctx);
  const c = url.searchParams.get('c'), id = url.searchParams.get('id'); if (!c || !id) throw new HttpError(400, 'c and id are required');
  send(res, 200, { rows: (await db.q('SELECT ver,op,data,by_user,ts FROM history WHERE tenant_id=? AND coll=? AND rid=? ORDER BY ver DESC LIMIT 100', [tid, c, id])).map(r => ({ ...r, data: r.data ? mapSecret(c, JSON.parse(r.data), () => MASK) : null })) });
};
H['GET /api/admin/roles'] = async (req, res, ctx, body, tid) => { needAdmin(ctx); send(res, 200, { roles: await getRoles(tid), protected: { developer_only: [...R.DEV_ONLY], admin_only: [...R.ADMIN_ONLY], append_only: [...R.APPEND_ONLY] } }); };
H['PUT /api/admin/roles'] = async (req, res, ctx, body, tid) => {
  needDev(ctx); const inp = body.roles; if (!inp || typeof inp !== 'object') throw new HttpError(400, 'roles object required');
  for (const [n, v] of Object.entries(inp)) {
    if (!/^[A-Za-z][A-Za-z0-9 _-]{1,40}$/.test(n) || !v || !Array.isArray(v.write) || !v.write.every(x => typeof x === 'string' && (x === '*' || NAME_RE.test(x)))) throw new HttpError(400, 'Invalid role definition: ' + n);
    if (n === R.DEV || n === R.ADMIN) continue;
    await db.q('INSERT INTO roles(tenant_id,name,write_rules,hr_access) VALUES(?,?,?,?) ON CONFLICT(tenant_id,name) DO UPDATE SET write_rules=excluded.write_rules, hr_access=excluded.hr_access', [tid, n, JSON.stringify(v.write), v.hr ? 1 : 0]);
  }
  roleCache.delete(tid); await audit(tid, ctx.user.name, 'roles_changed', Object.keys(inp).join(', '), ctx.ip); send(res, 200, { ok: true });
};
H['GET /api/admin/export'] = async (req, res, ctx, body, tid) => {
  needAdmin(ctx);
  const rows = await db.q('SELECT coll,rid,kind,data FROM records WHERE tenant_id=? AND deleted=0 ORDER BY coll,seq', [tid]), cols = {};
  for (const r of rows) { const c = cols[r.coll] || (cols[r.coll] = { kind: r.kind, records: [] }); c.records.push({ id: r.rid, data: outRecord(ctx.user.role, await getRoles(tid), r.coll, JSON.parse(r.data), null) }); }
  const counters = Object.fromEntries((await db.q('SELECT prefix,n FROM sequences WHERE tenant_id=?', [tid])).map(x => [x.prefix, Number(x.n)]));
  await audit(tid, ctx.user.name, 'export', rows.length + ' records (gateway keys and PIN hashes are not exported)', ctx.ip);
  send(res, 200, { format: 'ecbs-export-1', exported_at: new Date().toISOString(), collections: cols, counters });
};
H['POST /api/admin/import'] = async (req, res, ctx, body, tid) => {
  needAdmin(ctx); const roles = await getRoles(tid), ts = Date.now();
  const st = body.state; if (!st || typeof st !== 'object' || sec.unsafe(st)) throw new HttpError(400, 'state object required');
  const items = [];
  for (const [k, v] of Object.entries(st)) {
    if (k === 'users' || k === 'n' || !/^[a-z][a-z0-9_]{0,38}$/.test(k)) continue;
    if (Array.isArray(v)) v.forEach(x => { if (x && typeof x === 'object' && !Array.isArray(x)) { const id = x._id && ID_RE.test(String(x._id)) ? String(x._id) : sec.uuid(); items.push({ c: k, id, kind: 'arr', data: { ...x, _id: id } }); } });
    else if (v && typeof v === 'object') items.push({ c: 'obj:' + k, id: 'main', kind: 'obj', data: v });
  }
  if (items.some(i => R.DEV_ONLY.has(i.c)) && ctx.user.role !== R.DEV) items.splice(0, items.length, ...items.filter(i => !R.DEV_ONLY.has(i.c)));
  const out = await db.tx(async t => {
    const n = items.length + 1;
    const base = (await t.q('UPDATE tenants SET rev=rev+? WHERE id=? RETURNING rev', [n, tid]))[0].rev - n;
    if (body.replace !== false) await t.q("UPDATE records SET deleted=1, ver=ver+1, rev=?, updated_by=?, updated_at=? WHERE tenant_id=? AND deleted=0" + (ctx.user.role === R.DEV ? '' : " AND coll NOT IN ('obj:lic','plans')"), [base + n, ctx.user.name, ts, tid]);   // only the developer can replace the licence
    let i = 0;
    for (const it of items) {
      const rev = base + (++i);
      if (it.c === 'staff') it.data = await prepStaff(t, tid, it.data, true);
      const stored = JSON.stringify(mapSecret(it.c, keepSecrets(it.c, it.data, null), sec.encrypt));
      await t.q('INSERT INTO records(tenant_id,coll,rid,kind,seq,data,ver,deleted,rev,updated_by,updated_at) VALUES(?,?,?,?,?,?,1,0,?,?,?) ON CONFLICT(tenant_id,coll,rid) DO UPDATE SET data=excluded.data, kind=excluded.kind, seq=excluded.seq, ver=records.ver+1, deleted=0, rev=excluded.rev, updated_by=excluded.updated_by, updated_at=excluded.updated_at', [tid, it.c, it.id, it.kind, rev, stored, rev, ctx.user.name, ts]);
    }
    return items.length;
  });
  let counters = 0;
  const cn = st.n && typeof st.n === 'object' ? st.n : {};
  for (const [p, v] of Object.entries(cn)) if (/^[A-Za-z]{1,6}$/.test(p) && Number.isFinite(+v) && +v >= 0) { await db.q('INSERT INTO sequences(tenant_id,prefix,n) VALUES(?,?,?) ON CONFLICT(tenant_id,prefix) DO UPDATE SET n=CASE WHEN excluded.n>sequences.n THEN excluded.n ELSE sequences.n END', [tid, p, Math.floor(+v)]); counters++; }
  const created = [];
  if (Array.isArray(st.users) && body.create_users !== false) {
    let room = await platform.userRoom(tid);
    for (const x of st.users) {
      if (room <= 0) break;
      const name = String((x && (x.name || x.username)) || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 32);
      if (!USER_RE.test(name) || (await db.q('SELECT id FROM users WHERE tenant_id=? AND username=?', [tid, name])).length) continue;
      const role = roles[x.role] && x.role !== R.DEV ? x.role : 'Cashier', pw = sec.randomPassword();
      await db.q('INSERT INTO users(id,tenant_id,username,display,role,pw_hash,active,must_change,created_at) VALUES(?,?,?,?,?,?,1,1,?)', [sec.uuid(), tid, name, String(x.name || name).slice(0, 80), role, await sec.hashPw(pw), Date.now()]);
      created.push({ username: name, role, temp_password: pw }); room--;
    }
  }
  await audit(tid, ctx.user.name, 'import', out + ' records, ' + counters + ' counters, ' + created.length + ' users', ctx.ip);
  send(res, 200, { ok: true, records: out, counters, users_created: created });
};


/* --- server-side clock-in PIN check (hashes never leave the server) --- */
const PIN_MAXFAIL = +process.env.PIN_MAX_FAILS || 5;
const needHr = async (ctx, tid) => { const r = (await getRoles(tid))[ctx.user.role]; if (!r || !r.hr) throw new HttpError(403, 'HR / administrators only'); };
async function staffExists(tid, id) {
  for (const r of await db.q("SELECT data FROM records WHERE tenant_id=? AND coll='staff' AND deleted=0", [tid])) { try { if (String(JSON.parse(r.data).id) === String(id)) return true; } catch (e) {} }
  return false;
}
H['POST /api/pin/set'] = async (req, res, ctx, body, tid) => {
  await needHr(ctx, tid);
  const id = String(body.staff || ''), bad = sec.pinPolicy(body.pin);
  if (!ID_RE.test(id) || !(await staffExists(tid, id))) throw new HttpError(404, 'No such employee');
  if (bad) throw new HttpError(400, bad);
  await db.q('INSERT INTO staff_pins(tenant_id,staff_id,pin_hash,legacy,fails,locked_until,updated_at) VALUES(?,?,?,0,0,0,?) ON CONFLICT(tenant_id,staff_id) DO UPDATE SET pin_hash=excluded.pin_hash, legacy=0, fails=0, locked_until=0, updated_at=excluded.updated_at', [tid, id, await sec.hashPw(String(body.pin)), Date.now()]);
  await audit(tid, ctx.user.name, 'pin_set', 'employee ' + id, ctx.ip); send(res, 200, { ok: true });
};
H['POST /api/pin/unlock'] = async (req, res, ctx, body, tid) => {
  await needHr(ctx, tid); await db.q('UPDATE staff_pins SET fails=0, locked_until=0 WHERE tenant_id=? AND staff_id=?', [tid, String(body.staff || '')]);
  await audit(tid, ctx.user.name, 'pin_unlocked', 'employee ' + body.staff, ctx.ip); send(res, 200, { ok: true });
};
H['POST /api/pin/verify'] = async (req, res, ctx, body, tid) => {
  if (!rate('pin:' + ctx.user.id, 60, 60000)) throw new HttpError(429, 'Too many PIN attempts from this sign-in. Wait a minute.');
  const id = String(body.staff || ''), pin = String(body.pin || '');
  const row = ID_RE.test(id) ? (await db.q('SELECT pin_hash,legacy,fails,locked_until FROM staff_pins WHERE tenant_id=? AND staff_id=?', [tid, id]))[0] : null;
  if (!row) throw new HttpError(404, 'No PIN set – ask HR');
  const now = Date.now();
  if (row.locked_until > now) throw new HttpError(429, 'PIN locked after repeated wrong attempts. Try again in ' + Math.ceil((row.locked_until - now) / 60000) + ' min or ask HR to set a new PIN.');
  const ok = row.legacy ? row.pin_hash === sec.legacyPin(pin) : await sec.verifyPw(pin, row.pin_hash);
  const fails = (row.locked_until && row.locked_until <= now ? 0 : row.fails);
  if (!ok) {
    const f = fails + 1, lock = f >= PIN_MAXFAIL;
    await db.q('UPDATE staff_pins SET fails=?, locked_until=? WHERE tenant_id=? AND staff_id=?', [lock ? 0 : f, lock ? now + LOCK_MS : 0, tid, id]);
    await audit(tid, ctx.user.name, lock ? 'pin_locked' : 'pin_failed', 'employee ' + id, ctx.ip);
    throw new HttpError(403, lock ? 'Wrong PIN – locked for ' + Math.round(LOCK_MS / 60000) + ' minutes' : 'Wrong PIN (' + (PIN_MAXFAIL - f) + ' attempt' + (PIN_MAXFAIL - f === 1 ? '' : 's') + ' left)');
  }
  if (row.legacy) await db.q('UPDATE staff_pins SET pin_hash=?, legacy=0, fails=0, locked_until=0 WHERE tenant_id=? AND staff_id=?', [await sec.hashPw(pin), tid, id]);
  else if (fails || row.locked_until) await db.q('UPDATE staff_pins SET fails=0, locked_until=0 WHERE tenant_id=? AND staff_id=?', [tid, id]);
  send(res, 200, { ok: true, weak: pin.length < 6 });
};

/* --- gateway relay: the server talks to the SMS / STK gateway --- */
const canWriteAny = async (ctx, tid, colls) => { const r = (await getRoles(tid))[ctx.user.role]; if (!r || !(r.write.includes('*') || colls.some(c => r.write.includes(c)))) throw new HttpError(403, 'Your role may not send these'); };
async function secretRecord(tid, coll) {
  const r = (await db.q("SELECT data FROM records WHERE tenant_id=? AND coll=? AND rid='main' AND deleted=0", [tid, coll]))[0];
  return r ? mapSecret(coll, JSON.parse(r.data), sec.decrypt) : null;
}
H['POST /api/relay/sms'] = async (req, res, ctx, body, tid) => {
  await platform.needModule(tid, 'sms'); await canWriteAny(ctx, tid, ['sms']);
  if (!rate('sms:' + ctx.user.id, 30, 60000)) throw new HttpError(429, 'Too many SMS requests – wait a minute');
  const msgs = Array.isArray(body.messages) ? body.messages : []; if (!msgs.length || msgs.length > 100) throw new HttpError(400, 'Send between 1 and 100 messages per request');
  const out = await relay.sendSms(await secretRecord(tid, 'obj:smsc'), msgs);
  if (out.error) throw new HttpError(400, out.error);
  await audit(tid, ctx.user.name, 'sms_sent', out.results.filter(x => x.ok).length + ' sent, ' + out.results.filter(x => !x.ok).length + ' failed', ctx.ip);
  send(res, 200, out);
};
H['POST /api/relay/stk'] = async (req, res, ctx, body, tid) => {
  await platform.needModule(tid, 'mpesa'); await canWriteAny(ctx, tid, ['pays', 'trn']);
  if (!rate('stk:' + ctx.user.id, 20, 60000)) throw new HttpError(429, 'Too many STK requests – wait a minute');
  const gw = ((await secretRecord(tid, 'obj:pay')) || {}).gw, out = await relay.sendStk(gw, body);
  if (out.error) throw new HttpError(400, out.error);
  await audit(tid, ctx.user.name, out.ok ? 'stk_sent' : 'stk_failed', 'KES ' + (+body.amount || 0) + ' ref ' + String(body.reference || '').slice(0, 30), ctx.ip);
  send(res, 200, out);
};

/* --- nightly room billing --- */
const billing = require('./billing')({ audit, licenseBlocked, log, gate: async tid => { const p = await platform.planFor(tid); return !p.suspended && p.modules.includes('rooms'); } });
H['POST /api/billing/run'] = async (req, res, ctx, body, tid) => {
  await platform.needModule(tid, 'rooms'); await canWriteAny(ctx, tid, ['resv']);
  const r = await billing.run(tid, { manual: true, by: ctx.user.name, ip: ctx.ip });
  if (r.skipped) throw new HttpError(402, 'Billing not run: ' + r.skipped);
  send(res, 200, { ok: true, n: r.n, reservations: r.reservations, upTo: r.upTo });
};

/* --- unmatched M-Pesa settlement (rules enforced here, atomically) --- */
const mpesa = require('./mpesa')({ licenseBlocked });
const mpWrap = async fn => { try { return await fn(); } catch (e) { if (e instanceof mpesa.Err) throw new HttpError(e.status, e.message); throw e; } };
H['POST /api/mpesa/request'] = async (req, res, ctx, body, tid) => {
  await platform.needModule(tid, 'mpesa'); await canWriteAny(ctx, tid, ['mpu', 'pays', 'resv']);
  if (!rate('mps:' + ctx.user.id, 30, 60000)) throw new HttpError(429, 'Too many requests – wait a minute');
  const r = await mpWrap(() => mpesa.request(tid, ctx.user, body));
  await audit(tid, ctx.user.name, 'mpesa_settlement_requested', r.record.data.no + ' · ' + r.record.data.amt + ' → ' + r.record.data.target.label, ctx.ip); send(res, 200, r);
};
H['POST /api/mpesa/decide'] = async (req, res, ctx, body, tid) => {
  await platform.needModule(tid, 'mpesa');
  const r = await mpWrap(() => mpesa.decide(tid, ctx.user, body));
  await audit(tid, ctx.user.name, 'mpesa_settlement_' + r.record.data.st.toLowerCase(), r.record.data.no + ' · ' + r.record.data.amt, ctx.ip); send(res, 200, r);
};
H['POST /api/mpesa/reverse'] = async (req, res, ctx, body, tid) => {
  await platform.needModule(tid, 'mpesa');
  const r = await mpWrap(() => mpesa.reverse(tid, ctx.user, body));
  await audit(tid, ctx.user.name, 'mpesa_settlement_reversed', r.record.data.no + ' · ' + r.record.data.amt + ' · ' + (r.record.data.revWhy || '').slice(0, 120), ctx.ip); send(res, 200, r);
};

/* ---------- routing ---------- */
const PUBLIC = new Set(['POST /api/login']);
const NOCHANGE = new Set(['GET /api/me', 'POST /api/logout', 'POST /api/change-password']);
function match(method, p) {
  if (H[method + ' ' + p]) return { h: H[method + ' ' + p], key: method + ' ' + p, params: {} };
  const m = /^\/api\/admin\/(users|sessions)\/([A-Za-z0-9_-]+)$/.exec(p);
  if (m && H[`${method} /api/admin/${m[1]}/:id`]) return { h: H[`${method} /api/admin/${m[1]}/:id`], key: `${method} /api/admin/${m[1]}/:id`, params: { id: m[2] } };
  return null;
}
let INDEX = null;
const indexFile = () => path.join(__dirname, '..', 'public', 'index.html');
async function handle(req, res) {
  const url = new URL(req.url, 'http://local'), p = url.pathname, m = req.method;
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    if (await platform.handle(req, res, url)) return;
    const rr = await platform.resolveHost(hostOf(req)); if (rr.unknown) return send(res, 404, { error: 'This organisation address is not active.' });
    if (!INDEX) INDEX = fs.readFileSync(indexFile());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS }); return res.end(INDEX);
  }
  if (await platform.handle(req, res, url)) return;
  if (p === '/healthz') { await db.q('SELECT 1 AS ok'); return send(res, 200, { ok: true }); }
  if (p === '/favicon.ico') { res.writeHead(204, SEC_HEADERS); return res.end(); }
  const route = p.startsWith('/api/') ? match(m, p) : null;
  if (!route) return send(res, 404, { error: 'Not found' });
  if (m !== 'GET' && !originOk(req)) throw new HttpError(403, 'Cross-site request refused');
  const tid = await tenantFor(req); await ensureTenant(tid);
  if ((await platform.planFor(tid)).suspended) throw new HttpError(403, 'This account is suspended. Please contact Ettylinks to restore access.', { code: 'suspended' });
  let ctx = null;
  if (!PUBLIC.has(route.key)) {
    ctx = await authenticate(req);
    if (!ctx) throw new HttpError(401, 'Not signed in');
    if (!rate('api:' + ctx.user.id, 1200, 60000)) throw new HttpError(429, 'Too many requests');
    if (m !== 'GET') { const h = String(req.headers['x-csrf-token'] || ''); if (h.length !== ctx.csrf.length || !require('crypto').timingSafeEqual(Buffer.from(h), Buffer.from(ctx.csrf))) throw new HttpError(403, 'Bad CSRF token'); }
    if (ctx.user.must_change && !NOCHANGE.has(route.key)) throw new HttpError(403, 'Password change required', { code: 'password_change_required' });
    if (ctx.user.tenant !== tid) throw new HttpError(403, 'Wrong site');
  }
  const body = m === 'GET' || m === 'HEAD' || m === 'DELETE' ? {} : await readBody(req, route.key === 'POST /api/admin/import' ? IMPORT_MAX : BODY_MAX);
  await route.h(req, res, ctx, body, tid, url, route.params);
}
function server() {
  return http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
      log({ level: 'error', msg: e.message, stack: String(e.stack).split('\n').slice(0, 3).join(' | ') });
      if (!res.headersSent) send(res, 500, { error: 'Server error' });
    });
  });
}

/* ---------- first-run bootstrap ---------- */
async function bootstrap() {
  const tid = process.env.TENANT_ID || 'default'; await ensureTenant(tid); await getRoles(tid);
  const n = Number((await db.q('SELECT COUNT(*) c FROM users WHERE tenant_id=?', [tid]))[0].c);
  if (n) return;
  const mk = async (username, role, pw, label) => {
    const generated = !pw; pw = pw || sec.randomPassword();
    const bad = !generated && sec.pwPolicy(pw, username); if (bad) throw new Error(label + ' password rejected: ' + bad);
    await db.q('INSERT INTO users(id,tenant_id,username,display,role,pw_hash,active,must_change,created_at) VALUES(?,?,?,?,?,?,1,1,?)', [sec.uuid(), tid, username, username, role, await sec.hashPw(pw), Date.now()]);
    if (generated) console.log(`\n=== FIRST RUN: ${label} account "${username}" created. One-time password: ${pw}  (you must change it at first login) ===\n`);
  };
  await mk((process.env.ADMIN_USER || 'admin').toLowerCase(), R.ADMIN, process.env.ADMIN_PASSWORD, 'Administrator');
  if (process.env.DEV_USER) await mk(process.env.DEV_USER.toLowerCase(), R.DEV, process.env.DEV_PASSWORD, 'Developer');
}
async function start() {
  if (process.env.MIGRATE !== 'false') await db.migrate();
  await bootstrap();
  await platform.bootstrap();
  billing.start();
  const s = server();
  await new Promise(r => s.listen(PORT, HOST, r));
  if (process.env.NODE_ENV === 'production' && !SECURE) log({ level: 'warn', msg: 'COOKIE_SECURE=false in production: only use this on a private network without HTTPS' });
  if (process.env.NODE_ENV === 'production' && !process.env.DATA_KEY) log({ level: 'warn', msg: 'DATA_KEY is not set: SMS / M-Pesa gateway keys are stored unencrypted' });
  log({ msg: 'ECBS server listening', port: s.address().port, db: db.kind, secure_cookies: SECURE });
  const stop = () => { s.close(() => db.close().then(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return s;
}
if (require.main === module) start().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
module.exports = { start, server, bootstrap, billing };
