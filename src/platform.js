'use strict';
// ECBS Developer Platform: packages, clients (organisations), licensing, billing records and the developer panel API.
// Everything here is separate from the per-client HotelSuite data. Platform staff sign in at /platform (own accounts, own cookie).
const fs = require('fs'), path = require('path');

const PTID = '__platform__';
const OWNER = 'Platform Owner', SUPPORT = 'Platform Support';

/* ---------- module catalogue: what a package can switch on / off ----------
   groups  = top-level menu groups hidden when the module is off
   screens = single screens hidden when the module is off (inside groups that stay visible)
   colls   = data collections ONLY this module uses: the server refuses writes to them when the module is off          */
const MODULES = [
  { id: 'sales', name: 'Sales & POS', desc: 'POS, invoices, quotations, customers, payments, sales reports', groups: ['Sales'], screens: ['reports', 'debtors'], colls: ['sales', 'trn', 'pays', 'ccn', 'ginv', 'oinc', 'bdebt', 'vch'] },
  { id: 'mpesa', name: 'M-Pesa & Payment Gateway', desc: 'Unmatched M-Pesa, settlement approvals, STK push', groups: [], screens: ['mpu', 'mpset', 'mpreq'], colls: ['mpu', 'mps', 'mpw', 'obj:pay'] },
  { id: 'rooms', name: 'Rooms & Front Office', desc: 'Reservations, guests, folios, housekeeping, rates, nightly room billing', groups: ['Roomings'], screens: ['rreport'], colls: ['rooms', 'resv', 'guests', 'rrates', 'rpr', 'rcons'] },
  { id: 'hotelmgmt', name: 'Hotel Management', desc: 'Maintenance jobs, lost & found, airstrip pickups, excursions', groups: ['Hotel Management'], screens: [], colls: ['maint', 'lostfound', 'pickups', 'excursions'] },
  { id: 'assistant', name: 'Help Assistant (voice & chat)', desc: 'Guest-facing voice/chat assistant and its request inbox', groups: [], screens: ['asst', 'asstin', 'asstset'], colls: ['asst', 'obj:asstcfg'] },
  { id: 'spa', name: 'Gym & Spa', desc: 'Memberships and spa/gym bookings', groups: ['Gym & SPA'], screens: [], colls: ['members', 'spabook'] },
  { id: 'events', name: 'Functions & Ticketing', desc: 'Functions, event tickets, gate scanner', groups: ['Function Events'], screens: [], colls: ['functions', 'obj:ev', 'tickets', 'tpk', 'tbk'] },
  { id: 'inventory', name: 'Stores, Inventory & Assets', desc: 'Stock control, stores, requisitions, fixed assets, maintenance', groups: ['Stores & Inventory'], screens: ['stockval'], colls: ['stores', 'transfers', 'stockadj', 'grn', 'sissue', 'sret', 'counts', 'swo', 'stk', 'layers', 'batches', 'staffmeals', 'keepers', 'sph', 'atr', 'averify', 'wo', 'msch', 'assets', 'capex', 'obj:fa', 'obj:inv', 'agroups', 'alevels'] },
  { id: 'procurement', name: 'Procurement & Suppliers', desc: 'LPOs, quotations, supplier bills, pay bills, debit/credit notes', groups: ['Procurement'], screens: [], colls: ['preq', 'squo', 'lpo', 'suppliers', 'purchases', 'paysupp', 'debitnotes', 'cnotes'] },
  { id: 'accounts', name: 'Accounts & Banking', desc: 'Expenses, journals, banking, budgets, financial position', groups: ['Expenses & Accounts', 'Banking & Cash', 'Financial Position'], screens: [], colls: ['coa', 'journals', 'ajr', 'accounts', 'druns', 'expenses', 'banking', 'acats', 'gj', 'openbal', 'ccs', 'budgets', 'spq'] },
  { id: 'hr', name: 'HR & Payroll', desc: 'Employees, attendance, leave, payroll, biometric import', groups: ['Human Resource', 'Payroll'], screens: [], colls: ['staff', 'attend', 'leave', 'lv', 'bimp', 'shifts', 'biodev', 'obj:hr'] },
  { id: 'sms', name: 'SMS Messaging', desc: 'Bulk and automatic SMS through the gateway', groups: [], screens: ['sms'], colls: ['sms', 'smst', 'obj:smsc'] }
];
const ALL_IDS = MODULES.map(m => m.id), BYID = Object.fromEntries(MODULES.map(m => [m.id, m]));
const CYCLES = { monthly: 1, quarterly: 3, biannual: 6, yearly: 12 };
const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonths = (d, n) => { const x = new Date(d + 'T00:00:00Z'), day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const RESERVED = new Set(['platform', 'admin', 'www', 'api', 'app', 'default', 'mail', 'static', PTID]);
const SEED_PACKAGES = [
  { id: 'pos-basic', name: 'POS Basic', description: 'Point of sale, customers and stock for a restaurant, bar or shop.', price: 3000, cycle: 'monthly', max_users: 5, trial_days: 14, modules: ['sales', 'inventory'] },
  { id: 'hotel-standard', name: 'Hotel Standard', description: 'Rooms, POS, stores, procurement and accounts.', price: 8000, cycle: 'monthly', max_users: 15, trial_days: 30, modules: ['sales', 'rooms', 'hotelmgmt', 'inventory', 'procurement', 'accounts'] },
  { id: 'resort-complete', name: 'Resort Complete', description: 'Everything: rooms, spa, events, HR & payroll, M-Pesa, SMS and the voice assistant.', price: 15000, cycle: 'monthly', max_users: 0, trial_days: 30, modules: ALL_IDS }
];

module.exports = function platform(X) {
  const { db, sec, HttpError, send, audit, ensureTenant, getRoles, dropRoles, cookies, ipOf, rate, readBody, originOk, SECURE, MAXS, IDLE, attemptState, failAttempt, SEC_HEADERS, TENANT_MAP, log } = X;
  const PHOST = String(process.env.PLATFORM_HOST || '').trim().toLowerCase();
  const PDOMAIN = String(process.env.PLATFORM_DOMAIN || '').trim().toLowerCase().replace(/^\.+/, '');
  const PCOOKIE = (SECURE ? '__Host-' : '') + 'ecbs_psid';
  const pcookie = (v, age) => `${PCOOKIE}=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Strict${SECURE ? '; Secure' : ''}; Max-Age=${age}`;

  /* ---------- plans ---------- */
  const cache = new Map();
  const drop = tid => { if (tid) cache.delete(tid); else cache.clear(); };
  async function build(tid) {
    const cl = (await db.q('SELECT * FROM platform_clients WHERE tenant_id=?', [tid]))[0];
    if (!cl) return { managed: false, name: 'Standalone', package_id: null, status: 'active', suspended: false, modules: ALL_IDS.slice(), max_users: 0, paid_until: null, price: 0, currency: 'KES', cycle: 'monthly' };
    const pk = cl.package_id ? (await db.q('SELECT * FROM platform_packages WHERE id=?', [cl.package_id]))[0] : null;
    const set = new Set(pk ? J(pk.modules, []) : []);
    J(cl.add_modules, []).forEach(m => set.add(m)); J(cl.remove_modules, []).forEach(m => set.delete(m));
    const modules = ALL_IDS.filter(m => set.has(m)), off = MODULES.filter(m => !set.has(m.id));
    return {
      managed: true, name: pk ? pk.name : 'Custom', package_id: pk ? pk.id : null, status: cl.status, suspended: cl.status === 'suspended' || cl.status === 'cancelled',
      modules, max_users: cl.max_users != null ? +cl.max_users : (pk ? +pk.max_users : 0), paid_until: cl.paid_until || null,
      price: cl.price != null ? +cl.price : (pk ? +pk.price : 0), currency: pk ? pk.currency : 'KES', cycle: pk ? pk.cycle : 'monthly',
      blocked: off.flatMap(m => m.colls), groupsOff: off.flatMap(m => m.groups), screensOff: off.flatMap(m => m.screens), blockedMap: Object.fromEntries(off.flatMap(m => m.colls.map(c => [c, m.id])))
    };
  }
  async function planFor(tid) {
    const c = cache.get(tid); if (c && Date.now() - c.t < 15000) return c.v;
    const v = await build(tid); if (!v.blocked) { v.blocked = []; v.groupsOff = []; v.screensOff = []; v.blockedMap = {}; }
    cache.set(tid, { t: Date.now(), v }); return v;
  }
  const publicPlan = async tid => { const p = await planFor(tid); return { managed: p.managed, name: p.name, status: p.status, modules: p.modules, blocked: p.blocked, groupsOff: p.groupsOff, screensOff: p.screensOff, max_users: p.max_users, paid_until: p.paid_until }; };
  const collBlocked = (plan, coll) => (plan.blockedMap && plan.blockedMap[coll]) || null;
  async function needModule(tid, id) {
    const p = await planFor(tid);
    if (!p.modules.includes(id)) throw new HttpError(403, (BYID[id] ? BYID[id].name : id) + ' is not included in your package (' + p.name + '). Contact Ettylinks to upgrade.', { code: 'module' });
  }
  async function checkUserCap(tid) {
    const p = await planFor(tid); if (!p.max_users) return;
    const n = Number((await db.q("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND active=1 AND role<>'Developer Super Admin'", [tid]))[0].c);
    if (n >= p.max_users) throw new HttpError(402, 'Your package (' + p.name + ') allows ' + p.max_users + ' users. Contact Ettylinks to add more.', { code: 'user_limit' });
  }
  async function userRoom(tid) {   // how many more users may be added (Infinity = no limit)
    const p = await planFor(tid); if (!p.max_users) return Infinity;
    const n = Number((await db.q("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND active=1 AND role<>'Developer Super Admin'", [tid]))[0].c);
    return Math.max(0, p.max_users - n);
  }

  /* ---------- which organisation does a web address belong to? ---------- */
  const hcache = new Map();
  async function resolveHost(host) {
    host = String(host || '').toLowerCase();
    if (PHOST && host === PHOST) return { platform: true };
    if (TENANT_MAP[host]) return { tid: TENANT_MAP[host], mapped: true };
    const c = hcache.get(host); if (c && Date.now() - c.t < 30000) return c.v;
    let v = null;
    const r = (await db.q('SELECT tenant_id FROM tenant_hosts WHERE host=?', [host]))[0];
    if (r) v = { tid: r.tenant_id, mapped: true };
    else if (PDOMAIN && host.endsWith('.' + PDOMAIN)) {
      const slug = host.slice(0, -PDOMAIN.length - 1);
      const ok = SLUG_RE.test(slug) && (await db.q('SELECT 1 AS x FROM platform_clients WHERE tenant_id=?', [slug])).length;
      v = ok ? { tid: slug, mapped: true } : { unknown: true };
    } else v = { tid: process.env.TENANT_ID || 'default', mapped: false };
    hcache.set(host, { t: Date.now(), v }); return v;
  }
  const hostOf = req => String((TRUST_HOST(req))).split(':')[0].toLowerCase();
  const TRUST_HOST = req => (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-host']) || req.headers.host || '';
  const isPlatformHost = async host => PHOST ? host === PHOST : !!(await resolveHost(host)).tid && !(await resolveHost(host)).mapped;

  /* ---------- licence sync: the client's own licence record follows the package + payments ---------- */
  async function syncLicense(tid) {
    const cl = (await db.q('SELECT * FROM platform_clients WHERE tenant_id=?', [tid]))[0]; if (!cl) return;
    await ensureTenant(tid);
    const pl = await build(tid);
    await db.tx(async t => {
      const r = (await t.q("SELECT data FROM records WHERE tenant_id=? AND coll='obj:lic' AND rid='main'", [tid]))[0];
      const L = r ? J(r.data, {}) : {};
      L.status = pl.suspended ? 'Deactivated' : 'Active'; L.plan = pl.name; L.fee = pl.price; if (cl.paid_until) L.expiry = cl.paid_until;
      if (cl.name) L.org = cl.name; if (cl.contact) L.contact = cl.contact; if (cl.phone) L.phone = cl.phone; if (cl.email) L.email = cl.email;
      const rev = Number((await t.q('UPDATE tenants SET rev=rev+1 WHERE id=? RETURNING rev', [tid]))[0].rev);
      if (r) await t.q("UPDATE records SET data=?, ver=ver+1, deleted=0, rev=?, updated_by='platform', updated_at=? WHERE tenant_id=? AND coll='obj:lic' AND rid='main'", [JSON.stringify(L), rev, Date.now(), tid]);
      else await t.q("INSERT INTO records(tenant_id,coll,rid,kind,seq,data,ver,deleted,rev,updated_by,updated_at) VALUES(?,'obj:lic','main','obj',?,?,1,0,?,'platform',?)", [tid, rev, JSON.stringify(L), rev, Date.now()]);
    });
    drop(tid);
  }

  /* ---------- platform sessions ---------- */
  async function pauth(req) {
    const ck = cookies(req)[PCOOKIE]; if (!ck) return null;
    const sid = sec.sha(ck);
    const r = (await db.q('SELECT s.csrf,s.expires_at,s.last_seen,u.id uid,u.username,u.display,u.role,u.active,u.must_change FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.tenant_id=?', [sid, PTID]))[0];
    if (!r) return null;
    const now = Date.now();
    if (r.expires_at < now || now - r.last_seen > IDLE || !r.active) { await db.q('DELETE FROM sessions WHERE id=?', [sid]); return null; }
    if (now - r.last_seen > 30000) await db.q('UPDATE sessions SET last_seen=? WHERE id=?', [now, sid]);
    return { sid, csrf: r.csrf, ip: ipOf(req), user: { id: r.uid, name: r.username, display: r.display || r.username, role: r.role, must_change: !!r.must_change, owner: r.role === OWNER } };
  }
  const needOwner = ctx => { if (!ctx.user.owner) throw new HttpError(403, 'Only a Platform Owner can do this'); };
  const who = ctx => ctx.user.name;
  const pa = (ctx, action, detail) => audit(PTID, who(ctx), action, detail, ctx.ip);
  const num = (v, d) => { const n = Math.floor(+v); return Number.isFinite(n) && n >= 0 ? n : d; };

  /* ---------- data shapes ---------- */
  const pkgOut = p => ({ id: p.id, name: p.name, description: p.description || '', price: +p.price, currency: p.currency, cycle: p.cycle, modules: J(p.modules, []), max_users: +p.max_users, trial_days: +p.trial_days, active: !!p.active });
  async function hostsOf(tid) { return (await db.q('SELECT host FROM tenant_hosts WHERE tenant_id=? ORDER BY host', [tid])).map(r => r.host); }
  function urlFor(tid, hosts) { if (hosts && hosts[0]) return 'https://' + hosts[0]; if (PDOMAIN) return 'https://' + tid + '.' + PDOMAIN; return ''; }
  async function clientRows() {
    const rows = await db.q(`SELECT t.id tid, t.name tname, t.created_at tcreated, c.*,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.active=1) nusers,
      (SELECT MAX(u.last_login) FROM users u WHERE u.tenant_id=t.id) last_login,
      (SELECT MAX(r.updated_at) FROM records r WHERE r.tenant_id=t.id) activity
      FROM tenants t LEFT JOIN platform_clients c ON c.tenant_id=t.id WHERE t.id<>? ORDER BY t.created_at`, [PTID]);
    const hosts = {}; for (const h of await db.q('SELECT host,tenant_id FROM tenant_hosts ORDER BY host')) (hosts[h.tenant_id] = hosts[h.tenant_id] || []).push(h.host);
    const pk = Object.fromEntries((await db.q('SELECT * FROM platform_packages')).map(p => [p.id, p]));
    const out = [];
    for (const r of rows) {
      const p = r.package_id ? pk[r.package_id] : null, managed = !!r.created_at;
      const price = r.price != null ? +r.price : (p ? +p.price : 0), cyc = p ? p.cycle : 'monthly';
      out.push({
        id: r.tid, name: r.name || r.tname, managed, package_id: r.package_id || null, package: p ? p.name : (managed ? 'Custom' : '— (not managed)'), status: managed ? r.status : 'unmanaged',
        paid_until: r.paid_until || null, price, currency: p ? p.currency : 'KES', cycle: cyc, users: Number(r.nusers), max_users: r.max_users != null ? +r.max_users : (p ? +p.max_users : 0),
        last_login: r.last_login ? Number(r.last_login) : null, activity: r.activity ? Number(r.activity) : null, hosts: hosts[r.tid] || [], url: urlFor(r.tid, hosts[r.tid]),
        contact: r.contact || '', phone: r.phone || '', email: r.email || '', created_at: r.created_at ? Number(r.created_at) : Number(r.tcreated)
      });
    }
    return out;
  }

  /* ---------- API ---------- */
  const A = {};
  A['POST /api/platform/login'] = async (req, res, ctx, body) => {
    const username = String(body.username || '').trim().toLowerCase(), password = String(body.password || ''), ip = ipOf(req);
    if (!rate('plogin:' + ip, 40, 300000)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const keys = ['pu:' + username, 'pip:' + ip];
    for (const k of keys) { const s = await attemptState(k); if (s.locked_until > Date.now()) throw new HttpError(429, 'Temporarily locked after repeated failures. Try again later.'); }
    const u = (await db.q('SELECT id,username,display,role,pw_hash,active,must_change FROM users WHERE tenant_id=? AND username=?', [PTID, username]))[0];
    if (!A._dummy) A._dummy = await sec.hashPw('dummy-password-for-timing');
    const ok = await sec.verifyPw(password, u && u.pw_hash ? u.pw_hash : A._dummy) && u && u.active && u.pw_hash;
    if (!ok) { await failAttempt(keys[0], 5); await failAttempt(keys[1], 30); await audit(PTID, username || null, 'login_failed', null, ip); throw new HttpError(401, 'Invalid username or password'); }
    await db.q('DELETE FROM login_attempts WHERE k=?', [keys[0]]);
    const tok = sec.token(), csrf = sec.token(), now = Date.now();
    await db.q('INSERT INTO sessions(id,user_id,tenant_id,csrf,created_at,last_seen,expires_at,ip,ua) VALUES(?,?,?,?,?,?,?,?,?)', [sec.sha(tok), u.id, PTID, csrf, now, now, now + MAXS, ip, String(req.headers['user-agent'] || '').slice(0, 200)]);
    await db.q('UPDATE users SET last_login=? WHERE id=?', [now, u.id]);
    await audit(PTID, u.username, 'login', null, ip);
    send(res, 200, { user: { name: u.username, display: u.display || u.username, role: u.role, owner: u.role === OWNER, must_change: !!u.must_change }, csrf }, { 'Set-Cookie': pcookie(tok, MAXS / 1000) });
  };
  A['POST /api/platform/logout'] = async (req, res, ctx) => { await db.q('DELETE FROM sessions WHERE id=?', [ctx.sid]); send(res, 200, { ok: true }, { 'Set-Cookie': pcookie('', 0) }); };
  A['GET /api/platform/me'] = async (req, res, ctx) => send(res, 200, { user: ctx.user, csrf: ctx.csrf, platform_domain: PDOMAIN, platform_host: PHOST });
  A['POST /api/platform/change-password'] = async (req, res, ctx, body) => {
    const u = (await db.q('SELECT id,pw_hash FROM users WHERE id=?', [ctx.user.id]))[0];
    if (!(await sec.verifyPw(String(body.old || ''), u.pw_hash))) throw new HttpError(400, 'Current password is wrong');
    const bad = sec.pwPolicy(String(body.new || ''), ctx.user.name); if (bad) throw new HttpError(400, bad);
    if (body.new === body.old) throw new HttpError(400, 'Choose a different password');
    await db.q('UPDATE users SET pw_hash=?, must_change=0, pw_changed_at=? WHERE id=?', [await sec.hashPw(body.new), Date.now(), u.id]);
    await db.q('DELETE FROM sessions WHERE user_id=? AND id<>?', [u.id, ctx.sid]);
    await pa(ctx, 'password_changed'); send(res, 200, { ok: true });
  };
  A['GET /api/platform/modules'] = async (req, res) => send(res, 200, { modules: MODULES.map(m => ({ id: m.id, name: m.name, desc: m.desc })), cycles: Object.keys(CYCLES) });

  A['GET /api/platform/overview'] = async (req, res) => {
    const cl = await clientRows(), t = today(), soon = addDays(t, 14);
    const mrr = cl.filter(c => c.status === 'active').reduce((s, c) => s + c.price / (CYCLES[c.cycle] || 1), 0);
    const since = Date.now() - 30 * 864e5;
    const rev = (await db.q('SELECT currency, SUM(amount) s FROM platform_payments WHERE paid_at>=? GROUP BY currency', [since])).map(r => ({ currency: r.currency, total: Number(r.s) }));
    send(res, 200, {
      clients: cl.length, by_status: cl.reduce((o, c) => (o[c.status] = (o[c.status] || 0) + 1, o), {}), mrr: Math.round(mrr), revenue_30d: rev,
      expiring: cl.filter(c => c.managed && ['active', 'trial'].includes(c.status) && c.paid_until && c.paid_until >= t && c.paid_until <= soon).map(c => ({ id: c.id, name: c.name, paid_until: c.paid_until, package: c.package, status: c.status })),
      overdue: cl.filter(c => c.managed && ['active', 'trial'].includes(c.status) && c.paid_until && c.paid_until < t).map(c => ({ id: c.id, name: c.name, paid_until: c.paid_until, package: c.package, status: c.status })),
      packages: (await db.q('SELECT COUNT(*) c FROM platform_packages WHERE active=1'))[0].c
    });
  };

  /* packages */
  function pkgBody(b, cur) {
    const name = String(b.name == null ? (cur && cur.name) || '' : b.name).trim().slice(0, 60); if (!name) throw new HttpError(400, 'Package name is required');
    const mods = Array.isArray(b.modules) ? [...new Set(b.modules.filter(m => BYID[m]))] : (cur ? J(cur.modules, []) : []);
    const cycle = b.cycle == null ? (cur ? cur.cycle : 'monthly') : b.cycle; if (!CYCLES[cycle]) throw new HttpError(400, 'Billing cycle must be one of: ' + Object.keys(CYCLES).join(', '));
    return { name, description: String(b.description == null ? (cur && cur.description) || '' : b.description).slice(0, 300), price: num(b.price, cur ? +cur.price : 0), currency: String(b.currency || (cur && cur.currency) || 'KES').toUpperCase().slice(0, 4), cycle, modules: mods, max_users: num(b.max_users, cur ? +cur.max_users : 0), trial_days: num(b.trial_days, cur ? +cur.trial_days : 30), active: b.active == null ? (cur ? +cur.active : 1) : (b.active ? 1 : 0) };
  }
  A['GET /api/platform/packages'] = async (req, res) => {
    const rows = await db.q('SELECT * FROM platform_packages ORDER BY sort, price, name');
    const use = {}; for (const r of await db.q('SELECT package_id, COUNT(*) c FROM platform_clients GROUP BY package_id')) use[r.package_id] = Number(r.c);
    send(res, 200, { packages: rows.map(p => ({ ...pkgOut(p), clients: use[p.id] || 0 })) });
  };
  A['POST /api/platform/packages'] = async (req, res, ctx, body) => {
    needOwner(ctx); const b = pkgBody(body, null);
    const id = String(body.id || b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); if (!id) throw new HttpError(400, 'Invalid package name');
    if ((await db.q('SELECT 1 AS x FROM platform_packages WHERE id=?', [id])).length) throw new HttpError(409, 'A package with that name already exists');
    await db.q('INSERT INTO platform_packages(id,name,description,price,currency,cycle,modules,max_users,trial_days,active,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id, b.name, b.description, b.price, b.currency, b.cycle, JSON.stringify(b.modules), b.max_users, b.trial_days, b.active, 100, Date.now()]);
    await pa(ctx, 'package_created', b.name + ' · ' + b.currency + ' ' + b.price + '/' + b.cycle + ' · ' + b.modules.join(',')); send(res, 201, { id });
  };
  A['PUT /api/platform/packages/:id'] = async (req, res, ctx, body, url, prm) => {
    needOwner(ctx); const cur = (await db.q('SELECT * FROM platform_packages WHERE id=?', [prm.id]))[0]; if (!cur) throw new HttpError(404, 'No such package');
    const b = pkgBody(body, cur);
    await db.q('UPDATE platform_packages SET name=?,description=?,price=?,currency=?,cycle=?,modules=?,max_users=?,trial_days=?,active=? WHERE id=?', [b.name, b.description, b.price, b.currency, b.cycle, JSON.stringify(b.modules), b.max_users, b.trial_days, b.active, prm.id]);
    const users = await db.q('SELECT tenant_id FROM platform_clients WHERE package_id=?', [prm.id]);
    for (const c of users) { await syncLicense(c.tenant_id); await audit(c.tenant_id, 'ettylinks-platform', 'package_updated', b.name, ctx.ip); }
    drop(); await pa(ctx, 'package_updated', b.name + ' · ' + b.currency + ' ' + b.price + '/' + b.cycle + ' · ' + b.modules.join(',') + ' (affects ' + users.length + ' client(s))'); send(res, 200, { ok: true, affected: users.length });
  };
  A['DELETE /api/platform/packages/:id'] = async (req, res, ctx, body, url, prm) => {
    needOwner(ctx); const n = Number((await db.q('SELECT COUNT(*) c FROM platform_clients WHERE package_id=?', [prm.id]))[0].c);
    if (n) throw new HttpError(409, n + ' client(s) still use this package. Move them to another package first (or just switch the package off so it cannot be sold).');
    await db.q('DELETE FROM platform_packages WHERE id=?', [prm.id]); await pa(ctx, 'package_deleted', prm.id); send(res, 200, { ok: true });
  };

  /* clients */
  A['GET /api/platform/clients'] = async (req, res) => send(res, 200, { clients: await clientRows() });
  async function clientDetail(tid) {
    const row = (await clientRows()).find(c => c.id === tid); if (!row) throw new HttpError(404, 'No such client');
    const cl = (await db.q('SELECT * FROM platform_clients WHERE tenant_id=?', [tid]))[0] || {};
    const plan = await build(tid);
    row.add_modules = J(cl.add_modules, []); row.remove_modules = J(cl.remove_modules, []); row.notes = cl.notes || ''; row.country = cl.country || '';
    row.max_users_override = cl.max_users != null ? +cl.max_users : null; row.price_override = cl.price != null ? +cl.price : null;
    row.modules = plan.modules; row.licence = (() => { return null; })();
    row.users_list = (await db.q('SELECT username,display,role,active,last_login FROM users WHERE tenant_id=? ORDER BY username', [tid])).map(u => ({ username: u.username, display: u.display || '', role: u.role, active: !!u.active, last_login: u.last_login ? Number(u.last_login) : null }));
    row.payments = (await db.q('SELECT * FROM platform_payments WHERE tenant_id=? ORDER BY paid_at DESC LIMIT 100', [tid])).map(payOut);
    return row;
  }
  const payOut = p => ({ id: p.id, tenant_id: p.tenant_id, amount: Number(p.amount), currency: p.currency, method: p.method || '', ref: p.ref || '', package_id: p.package_id, period_from: p.period_from, period_to: p.period_to, note: p.note || '', by: p.by_user || '', paid_at: Number(p.paid_at) });
  A['GET /api/platform/clients/:id'] = async (req, res, ctx, body, url, prm) => send(res, 200, await clientDetail(prm.id));

  async function setHosts(tid, hosts) {
    const list = [...new Set((hosts || []).map(h => String(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
    for (const h of list) {
      if (!HOST_RE.test(h)) throw new HttpError(400, 'Invalid web address: ' + h);
      if (h === PHOST) throw new HttpError(400, h + ' is the developer panel address');
      const ex = (await db.q('SELECT tenant_id FROM tenant_hosts WHERE host=?', [h]))[0];
      if (ex && ex.tenant_id !== tid) throw new HttpError(409, h + ' already belongs to another client');
    }
    await db.q('DELETE FROM tenant_hosts WHERE tenant_id=?', [tid]);
    for (const h of list) await db.q('INSERT INTO tenant_hosts(host,tenant_id) VALUES(?,?)', [h, tid]);
    hcache.clear();
  }
  A['POST /api/platform/clients'] = async (req, res, ctx, body) => {
    needOwner(ctx);
    const name = String(body.name || '').trim().slice(0, 100); if (!name) throw new HttpError(400, 'Organisation name is required');
    const slug = String(body.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!SLUG_RE.test(slug) || RESERVED.has(slug)) throw new HttpError(400, 'Choose a short code of 3-32 letters/numbers/dashes (not a reserved word)');
    if ((await db.q('SELECT 1 AS x FROM tenants WHERE id=?', [slug])).length) throw new HttpError(409, 'That code is already used by another organisation');
    const pk = (await db.q('SELECT * FROM platform_packages WHERE id=?', [body.package_id]))[0]; if (!pk) throw new HttpError(400, 'Choose a package');
    const admin = String(body.admin_user || 'admin').trim().toLowerCase(); if (!/^[a-z0-9._-]{3,32}$/.test(admin)) throw new HttpError(400, 'Admin username: 3-32 letters, numbers, dot, dash or underscore');
    let pw = body.admin_password, temp = null; if (pw) { const bad = sec.pwPolicy(pw, admin); if (bad) throw new HttpError(400, bad); } else pw = temp = sec.randomPassword();
    const trial = body.paid_until && DATE_RE.test(body.paid_until) ? body.paid_until : addDays(today(), body.trial_days != null ? num(body.trial_days, 30) : +pk.trial_days);
    const status = ['trial', 'active'].includes(body.status) ? body.status : 'trial', now = Date.now();
    await ensureTenant(slug);
    await db.q('UPDATE tenants SET name=? WHERE id=?', [name, slug]);
    await getRoles(slug);
    await db.q('INSERT INTO platform_clients(tenant_id,name,package_id,add_modules,remove_modules,max_users,price,status,paid_until,contact,phone,email,country,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [slug, name, pk.id, '[]', '[]', body.max_users == null || body.max_users === '' ? null : num(body.max_users, 0), body.price == null || body.price === '' ? null : num(body.price, 0), status, trial, String(body.contact || '').slice(0, 100), String(body.phone || '').slice(0, 40), String(body.email || '').slice(0, 120), String(body.country || '').slice(0, 60), String(body.notes || '').slice(0, 1000), now, now]);
    await db.q('INSERT INTO users(id,tenant_id,username,display,role,pw_hash,active,must_change,created_at) VALUES(?,?,?,?,?,?,1,1,?)', [sec.uuid(), slug, admin, String(body.contact || admin).slice(0, 80), R_ADMIN, await sec.hashPw(pw), now]);
    await setHosts(slug, body.hosts);
    await syncLicense(slug);
    await pa(ctx, 'client_created', name + ' (' + slug + ') · package ' + pk.name); await audit(slug, 'ettylinks-platform', 'organisation_created', 'package ' + pk.name, ctx.ip);
    send(res, 201, { id: slug, admin_user: admin, temp_password: temp, url: urlFor(slug, await hostsOf(slug)), paid_until: trial });
  };
  const R_ADMIN = 'Admin';
  A['PUT /api/platform/clients/:id'] = async (req, res, ctx, body, url, prm) => {
    const tid = prm.id;
    if (!ctx.user.owner) { const k = Object.keys(body); if (k.some(x => !['notes', 'contact', 'phone', 'email', 'country'].includes(x))) throw new HttpError(403, 'Support accounts can only edit contact details and notes'); }
    if (!(await db.q('SELECT 1 AS x FROM tenants WHERE id=? AND id<>?', [tid, PTID])).length) throw new HttpError(404, 'No such client');
    let cl = (await db.q('SELECT * FROM platform_clients WHERE tenant_id=?', [tid]))[0];
    if (!cl) {   // adopt an existing standalone site (e.g. the original single-hotel install) into the platform
      const t0 = (await db.q('SELECT name FROM tenants WHERE id=?', [tid]))[0], now = Date.now();
      await db.q('INSERT INTO platform_clients(tenant_id,name,package_id,add_modules,remove_modules,status,paid_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', [tid, t0.name || tid, body.package_id || null, '[]', '[]', 'active', body.paid_until || addDays(today(), 365), now, now]);
      cl = (await db.q('SELECT * FROM platform_clients WHERE tenant_id=?', [tid]))[0];
    }
    const f = {}, S = (k, v) => { f[k] = v; };
    if (body.name != null) S('name', String(body.name).trim().slice(0, 100) || cl.name);
    if (body.package_id != null) { if (!(await db.q('SELECT 1 AS x FROM platform_packages WHERE id=?', [body.package_id])).length) throw new HttpError(400, 'No such package'); S('package_id', body.package_id); }
    if (Array.isArray(body.add_modules)) S('add_modules', JSON.stringify([...new Set(body.add_modules.filter(m => BYID[m]))]));
    if (Array.isArray(body.remove_modules)) S('remove_modules', JSON.stringify([...new Set(body.remove_modules.filter(m => BYID[m]))]));
    if ('max_users' in body) S('max_users', body.max_users === null || body.max_users === '' ? null : num(body.max_users, 0));
    if ('price' in body) S('price', body.price === null || body.price === '' ? null : num(body.price, 0));
    if (body.status != null) { if (!['trial', 'active', 'suspended', 'cancelled'].includes(body.status)) throw new HttpError(400, 'Bad status'); S('status', body.status); }
    if (body.paid_until != null) { if (body.paid_until !== '' && !DATE_RE.test(body.paid_until)) throw new HttpError(400, 'Date must be YYYY-MM-DD'); S('paid_until', body.paid_until || null); }
    for (const k of ['contact', 'phone', 'email', 'country', 'notes']) if (body[k] != null) S(k, String(body[k]).slice(0, k === 'notes' ? 1000 : 120));
    const keys = Object.keys(f);
    if (keys.length) await db.q('UPDATE platform_clients SET ' + keys.map(k => k + '=?').join(',') + ', updated_at=? WHERE tenant_id=?', [...keys.map(k => f[k]), Date.now(), tid]);
    if (Array.isArray(body.hosts)) await setHosts(tid, body.hosts);
    drop(tid);
    if (f.status === 'suspended' || f.status === 'cancelled') await db.q('DELETE FROM sessions WHERE tenant_id=?', [tid]);
    await syncLicense(tid);
    const what = keys.filter(k => k !== 'notes').map(k => k + '=' + (k === 'add_modules' || k === 'remove_modules' ? f[k] : f[k])).join('; ') + (Array.isArray(body.hosts) ? '; hosts=' + body.hosts.join(',') : '');
    await pa(ctx, 'client_updated', tid + ' · ' + what.slice(0, 400)); await audit(tid, 'ettylinks-platform', 'plan_updated', what.slice(0, 400), ctx.ip);
    send(res, 200, await clientDetail(tid));
  };
  A['POST /api/platform/clients/:id/payment'] = async (req, res, ctx, body, url, prm) => {
    needOwner(ctx); const tid = prm.id;
    const cl = (await db.q('SELECT * FROM platform_clients WHERE tenant_id=?', [tid]))[0]; if (!cl) throw new HttpError(404, 'This client is not managed yet - assign a package first');
    const plan = await build(tid), amount = num(body.amount, -1), periods = Math.max(1, Math.min(60, num(body.periods, 1)));
    if (amount < 0) throw new HttpError(400, 'Enter the amount received');
    const months = (CYCLES[plan.cycle] || 1) * periods, t = today(), from = cl.paid_until && cl.paid_until > t ? cl.paid_until : t, to = addMonths(from, months);
    const id = sec.uuid();
    await db.q('INSERT INTO platform_payments(id,tenant_id,amount,currency,method,ref,package_id,period_from,period_to,note,by_user,paid_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id, tid, amount, plan.currency, String(body.method || '').slice(0, 30), String(body.ref || '').slice(0, 60), cl.package_id, from, to, String(body.note || '').slice(0, 300), who(ctx), Date.now()]);
    await db.q("UPDATE platform_clients SET paid_until=?, status=CASE WHEN status IN ('suspended','cancelled') THEN 'active' ELSE 'active' END, updated_at=? WHERE tenant_id=?", [to, Date.now(), tid]);
    drop(tid); await syncLicense(tid);
    await pa(ctx, 'payment_recorded', tid + ' · ' + plan.currency + ' ' + amount + ' · ' + (body.method || '') + ' ' + (body.ref || '') + ' · paid until ' + to); await audit(tid, 'ettylinks-platform', 'subscription_paid', 'paid until ' + to, ctx.ip);
    send(res, 201, { id, paid_until: to });
  };
  A['POST /api/platform/clients/:id/reset-admin'] = async (req, res, ctx, body, url, prm) => {
    const tid = prm.id;
    const u = body.username ? (await db.q('SELECT * FROM users WHERE tenant_id=? AND username=?', [tid, String(body.username).toLowerCase()]))[0] : (await db.q("SELECT * FROM users WHERE tenant_id=? AND role='Admin' ORDER BY created_at LIMIT 1", [tid]))[0];
    if (!u) throw new HttpError(404, 'No such user in that organisation');
    const pw = sec.randomPassword();
    await db.q('UPDATE users SET pw_hash=?, must_change=1, active=1 WHERE id=?', [await sec.hashPw(pw), u.id]);
    await db.q('DELETE FROM sessions WHERE user_id=?', [u.id]); await db.q('DELETE FROM login_attempts WHERE k=?', ['u:' + tid + ':' + u.username]);
    await pa(ctx, 'client_password_reset', tid + ' · ' + u.username); await audit(tid, 'ettylinks-platform', 'password_reset_by_platform', u.username, ctx.ip);
    send(res, 200, { username: u.username, temp_password: pw });
  };
  A['GET /api/platform/payments'] = async (req, res) => {
    const names = Object.fromEntries((await clientRows()).map(c => [c.id, c.name]));
    send(res, 200, { payments: (await db.q('SELECT * FROM platform_payments ORDER BY paid_at DESC LIMIT 500')).map(p => ({ ...payOut(p), client: names[p.tenant_id] || p.tenant_id })) });
  };

  /* platform staff */
  A['GET /api/platform/users'] = async (req, res, ctx) => { needOwner(ctx); send(res, 200, { users: (await db.q('SELECT id,username,display,role,active,last_login FROM users WHERE tenant_id=? ORDER BY username', [PTID])).map(u => ({ id: u.id, username: u.username, display: u.display || '', role: u.role, active: !!u.active, last_login: u.last_login ? Number(u.last_login) : null })) }); };
  A['POST /api/platform/users'] = async (req, res, ctx, body) => {
    needOwner(ctx); const username = String(body.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'Username: 3-32 letters, numbers, dot, dash or underscore');
    if (![OWNER, SUPPORT].includes(body.role)) throw new HttpError(400, 'Role must be ' + OWNER + ' or ' + SUPPORT);
    if ((await db.q('SELECT 1 AS x FROM users WHERE tenant_id=? AND username=?', [PTID, username])).length) throw new HttpError(409, 'That username already exists');
    let pw = body.password, temp = null; if (pw) { const bad = sec.pwPolicy(pw, username); if (bad) throw new HttpError(400, bad); } else pw = temp = sec.randomPassword();
    await db.q('INSERT INTO users(id,tenant_id,username,display,role,pw_hash,active,must_change,created_at) VALUES(?,?,?,?,?,?,1,1,?)', [sec.uuid(), PTID, username, String(body.display || '').slice(0, 80) || null, body.role, await sec.hashPw(pw), Date.now()]);
    await pa(ctx, 'staff_created', username + ' (' + body.role + ')'); send(res, 201, { username, temp_password: temp });
  };
  const owners = async except => Number((await db.q("SELECT COUNT(*) c FROM users WHERE tenant_id=? AND role=? AND active=1 AND id<>?", [PTID, OWNER, except || '']))[0].c);
  A['PUT /api/platform/users/:id'] = async (req, res, ctx, body, url, prm) => {
    needOwner(ctx); const u = (await db.q('SELECT * FROM users WHERE tenant_id=? AND id=?', [PTID, prm.id]))[0]; if (!u) throw new HttpError(404, 'No such user');
    const role = body.role != null ? body.role : u.role, active = body.active != null ? (body.active ? 1 : 0) : u.active;
    if (![OWNER, SUPPORT].includes(role)) throw new HttpError(400, 'Bad role');
    if ((role !== OWNER || !active) && u.role === OWNER && !(await owners(u.id))) throw new HttpError(400, 'There must be at least one active Platform Owner');
    await db.q('UPDATE users SET role=?, active=? WHERE id=?', [role, active, u.id]); if (!active) await db.q('DELETE FROM sessions WHERE user_id=?', [u.id]);
    await pa(ctx, 'staff_updated', u.username + ' role=' + role + ' active=' + active); send(res, 200, { ok: true });
  };
  A['POST /api/platform/users/:id/reset'] = async (req, res, ctx, body, url, prm) => {
    needOwner(ctx); const u = (await db.q('SELECT * FROM users WHERE tenant_id=? AND id=?', [PTID, prm.id]))[0]; if (!u) throw new HttpError(404, 'No such user');
    const pw = sec.randomPassword(); await db.q('UPDATE users SET pw_hash=?, must_change=1 WHERE id=?', [await sec.hashPw(pw), u.id]); await db.q('DELETE FROM sessions WHERE user_id=?', [u.id]); await db.q('DELETE FROM login_attempts WHERE k=?', ['pu:' + u.username]);
    await pa(ctx, 'staff_password_reset', u.username); send(res, 200, { username: u.username, temp_password: pw });
  };
  A['GET /api/platform/audit'] = async (req, res, ctx, body, url) => {
    const tid = url.searchParams.get('tenant');
    const rows = tid ? await db.q('SELECT id,ts,user_name,action,detail,ip FROM audit_log WHERE tenant_id=? ORDER BY id DESC LIMIT 200', [tid]) : await db.q('SELECT id,ts,user_name,action,detail,ip FROM audit_log WHERE tenant_id=? ORDER BY id DESC LIMIT 300', [PTID]);
    send(res, 200, { rows: rows.map(r => ({ id: Number(r.id), ts: Number(r.ts), user: r.user_name, action: r.action, detail: r.detail, ip: r.ip })) });
  };

  function matchApi(m, p) {
    if (A[m + ' ' + p]) return { h: A[m + ' ' + p], key: m + ' ' + p, prm: {} };
    let x = /^\/api\/platform\/(packages|clients|users)\/([A-Za-z0-9_.-]+)(\/(payment|reset-admin|reset))?$/.exec(p);
    if (x) { const k = m + ' /api/platform/' + x[1] + '/:id' + (x[3] || ''); if (A[k]) return { h: A[k], key: k, prm: { id: x[2] } }; }
    return null;
  }

  /* ---------- pages & assets ---------- */
  const PUB = path.join(__dirname, '..', 'public');
  const FILES = { '/platform': ['platform.html', 'text/html; charset=utf-8'], '/platform/': ['platform.html', 'text/html; charset=utf-8'], '/platform/logo.jpg': ['platform/logo.jpg', 'image/jpeg'], '/favicon.ico': ['platform/favicon.ico', 'image/x-icon'], '/platform/favicon.ico': ['platform/favicon.ico', 'image/x-icon'] };
  for (const n of [32, 64, 180, 192, 512]) FILES['/platform/favicon-' + n + '.png'] = ['platform/favicon-' + n + '.png', 'image/png'];
  const fcache = new Map();
  function serve(res, p) {
    const f = FILES[p]; if (!f) return false;
    let b = fcache.get(f[0]); if (!b) { b = fs.readFileSync(path.join(PUB, f[0])); fcache.set(f[0], b); }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': f[0] === 'platform.html' ? 'no-store' : 'public, max-age=86400', ...SEC_HEADERS }); res.end(b); return true;
  }

  // returns true when the request was handled here
  async function handle(req, res, url) {
    const p = url.pathname, m = req.method, host = hostOf(req);
    if (p === '/' || p === '/favicon.ico') {
      if (!PHOST || host !== PHOST) return false;
      if (p === '/') { res.writeHead(302, { Location: '/platform', ...SEC_HEADERS }); res.end(); return true; }
      return serve(res, p);
    }
    const isApi = p.startsWith('/api/platform/'), isPage = p === '/platform' || p.startsWith('/platform/');
    if (!isApi && !isPage) return false;
    if (!(await isPlatformHost(host))) { send(res, 404, { error: 'Not found' }); return true; }
    if (isPage) { if (m !== 'GET' || !serve(res, p)) send(res, 404, { error: 'Not found' }); return true; }
    const route = matchApi(m, p); if (!route) { send(res, 404, { error: 'Not found' }); return true; }
    if (m !== 'GET' && !originOk(req)) throw new HttpError(403, 'Cross-site request refused');
    let ctx = null;
    if (route.key !== 'POST /api/platform/login') {
      ctx = await pauth(req); if (!ctx) throw new HttpError(401, 'Not signed in');
      if (m !== 'GET') { const h = String(req.headers['x-csrf-token'] || ''); if (h.length !== ctx.csrf.length || !require('crypto').timingSafeEqual(Buffer.from(h), Buffer.from(ctx.csrf))) throw new HttpError(403, 'Bad CSRF token'); }
      if (ctx.user.must_change && !['GET /api/platform/me', 'POST /api/platform/logout', 'POST /api/platform/change-password'].includes(route.key)) throw new HttpError(403, 'Password change required', { code: 'password_change_required' });
    }
    const body = m === 'GET' || m === 'DELETE' ? {} : await readBody(req, 1048576);
    await route.h(req, res, ctx, body, url, route.prm); return true;
  }

  /* ---------- first run ---------- */
  async function bootstrap() {
    if (!(await db.q('SELECT 1 AS x FROM platform_packages LIMIT 1')).length) {
      let i = 0; for (const p of SEED_PACKAGES) await db.q('INSERT INTO platform_packages(id,name,description,price,currency,cycle,modules,max_users,trial_days,active,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)', [p.id, p.name, p.description, p.price, 'KES', p.cycle, JSON.stringify(p.modules), p.max_users, p.trial_days, ++i, Date.now()]);
    }
    const username0 = String(process.env.PLATFORM_OWNER_USER || 'ettylinks').toLowerCase();
    // Recovery: set secrets PLATFORM_OWNER_RESET=true + PLATFORM_OWNER_PASSWORD, restart, sign in, then DELETE the RESET secret.
    if (process.env.PLATFORM_OWNER_RESET === 'true' && process.env.PLATFORM_OWNER_PASSWORD) {
      const bad = sec.pwPolicy(process.env.PLATFORM_OWNER_PASSWORD, username0); if (bad) throw new Error('PLATFORM_OWNER_PASSWORD rejected: ' + bad);
      const h = await sec.hashPw(process.env.PLATFORM_OWNER_PASSWORD), ex = (await db.q('SELECT id FROM users WHERE tenant_id=? AND username=?', [PTID, username0]))[0];
      if (ex) { await db.q('UPDATE users SET pw_hash=?, role=?, active=1, must_change=1 WHERE id=?', [h, OWNER, ex.id]); await db.q('DELETE FROM sessions WHERE user_id=?', [ex.id]); }
      else await db.q('INSERT INTO users(id,tenant_id,username,display,role,pw_hash,active,must_change,created_at) VALUES(?,?,?,?,?,?,1,1,?)', [sec.uuid(), PTID, username0, 'Ettylinks Owner', OWNER, h, Date.now()]);
      await db.q('DELETE FROM login_attempts WHERE k LIKE ?', ['p%']);
      log({ level: 'warn', msg: 'PLATFORM_OWNER_RESET is on: owner "' + username0 + '" password was set from PLATFORM_OWNER_PASSWORD. Delete the PLATFORM_OWNER_RESET secret now.' });
      return;
    }
    if (Number((await db.q('SELECT COUNT(*) c FROM users WHERE tenant_id=?', [PTID]))[0].c)) return;
    const username = username0; let pw = process.env.PLATFORM_OWNER_PASSWORD; const gen = !pw; pw = pw || sec.randomPassword();
    const bad = !gen && sec.pwPolicy(pw, username); if (bad) throw new Error('PLATFORM_OWNER_PASSWORD rejected: ' + bad);
    await db.q('INSERT INTO users(id,tenant_id,username,display,role,pw_hash,active,must_change,created_at) VALUES(?,?,?,?,?,?,1,1,?)', [sec.uuid(), PTID, username, 'Ettylinks Owner', OWNER, await sec.hashPw(pw), Date.now()]);
    if (gen) console.log(`\n=== FIRST RUN: developer panel owner "${username}" created. One-time password: ${pw}  (change it at first login; panel is at /platform) ===\n`);
  }

  return { handle, bootstrap, resolveHost, planFor, publicPlan, collBlocked, needModule, checkUserCap, userRoom, syncLicense, drop, MODULES, PTID };
};
module.exports.MODULES = MODULES;
