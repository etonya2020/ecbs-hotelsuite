'use strict';
// End-to-end: the REAL browser script (public/index.html) running against the REAL server process.
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { spawn, execFileSync } = require('node:child_process'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const PORT = 4300 + Math.floor(Math.random() * 400), BASE = 'http://127.0.0.1:' + PORT;
const DBFILE = path.join(os.tmpdir(), 'ecbs-e2e-' + process.pid + '.db');
const SRC = (() => { const h = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'); return /<script>([\s\S]*)<\/script>/.exec(h)[1]; })();
let child;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(jar, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie: jar.cookie || '', ...(jar.csrf && method !== 'GET' ? { 'X-CSRF-Token': jar.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jar.cookie = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, body: j };
}
async function loginJar(user, pw, newpw) {
  const jar = {}; const r = await api(jar, 'POST', '/api/login', { username: user, password: pw }); assert.equal(r.status, 200, user + ' login'); jar.csrf = r.body.csrf;
  if (newpw && r.body.user.must_change) assert.equal((await api(jar, 'POST', '/api/change-password', { old: pw, new: newpw })).status, 200);
  return jar;
}
const P = () => new Proxy(function () {}, { get: (t, k) => k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === 'dataset' ? {} : k === 'style' ? {} : k === Symbol.toPrimitive ? () => '' : P(), set: () => true, apply: () => P() });
function mkClient(jar) {
  const timers = [];
  class XHR { open(m, u) { this.m = m; this.u = u; this.h = {}; } setRequestHeader(k, v) { this.h[k] = v; }
    send(b) { const a = ['-s', '-i', '-X', this.m, BASE + this.u, '-H', 'Expect:', '-H', 'Cookie: ' + (jar.cookie || '')]; for (const k in this.h) a.push('-H', k + ': ' + this.h[k]); if (b) a.push('--data-binary', b);
      const out = execFileSync('curl', a, { maxBuffer: 1 << 28 }).toString(), i = out.indexOf('\r\n\r\n'); this.status = +out.split(' ')[1]; this.responseText = out.slice(i + 4); } }
  const sb = { console, URL, Blob: function () {}, TextEncoder, Uint8Array, Promise, Set, Map, JSON, Math, Date, Object, Array, Number, String, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    document: { addEventListener() {}, querySelector: s => /\.show/.test(s) ? null : P(), querySelectorAll: () => [], documentElement: { style: { setProperty() {} }, removeAttribute() {}, setAttribute() {} }, body: { classList: { add() {}, remove() {} } }, createElement: () => P(), hidden: false, activeElement: { tagName: 'BODY' } },
    window: { scrollTo() {}, crypto: require('node:crypto').webcrypto }, crypto: require('node:crypto').webcrypto, localStorage: { getItem: k => (k === 'ecbs_wmode' ? 'off' : null), setItem() {} }, navigator: { userAgent: 'x' }, QRCode: function () {}, location: { protocol: 'https:', reload() { sb.__reloads++; } }, __reloads: 0,
    XMLHttpRequest: XHR, fetch: (u, o = {}) => fetch(BASE + u, { ...o, headers: { ...(o.headers || {}), cookie: jar.cookie || '' } }), setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {}, scrollTo() {}, scrollY: 0, alert() {}, confirm: () => true };
  sb.global = sb; vm.createContext(sb); vm.runInContext(SRC, sb);
  return { sb, run: code => vm.runInContext(code, sb), timers, get SRV() { return vm.runInContext('SRV', sb); }, async settle() { for (let i = 0; i < 60; i++) { while (timers.length) timers.shift()(); await sleep(60); const S = vm.runInContext('SRV', sb); if (!S.busy && !S.dirty && !timers.length) return; } } };
}
test.before(async () => {
  child = spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: 'sqlite:' + DBFILE, COOKIE_SECURE: 'false', SCRYPT_N: '1024', ADMIN_PASSWORD: 'Adm1n!Start-2026', DEV_USER: 'edbis', DEV_PASSWORD: 'Dev!Start-2026-xx', DATA_KEY: 'e2e', LOGIN_RATE_MAX: '1000', BILLING_TIMER: 'off', RELAY_ALLOW_PRIVATE: 'true', RELAY_ALLOW_HTTP: 'true', TZ: 'UTC' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch (e) {} await sleep(100); }
  throw new Error('server did not start');
});
test.after(() => { child.kill(); for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) try { fs.unlinkSync(f); } catch (e) {} });
let adminJar, A, B;

test('not signed in: the app shows only the login screen and holds no business data', async () => {
  const c = mkClient({});
  assert.equal(c.SRV.on, false); assert.equal(c.SRV.me, null);
  c.run('save(); srvStart()'); assert.equal(c.timers.length, 0);                                  // nothing is ever sent or stored
});
test('first administrator login: forced password change, then first-run upload to the database', async () => {
  const jar = {}; const r = await api(jar, 'POST', '/api/login', { username: 'admin', password: 'Adm1n!Start-2026' }); jar.csrf = r.body.csrf;
  const c0 = mkClient(jar); assert.equal(c0.SRV.me.must_change, true); assert.equal(c0.SRV.on, false);
  c0.run('srvStart()');                                                                              // shows the forced-change dialog
  assert.equal((await api(jar, 'POST', '/api/change-password', { old: 'Adm1n!Start-2026', new: 'Better#Pass-9981' })).status, 200);
  adminJar = jar; A = mkClient(jar);
  assert.equal(A.SRV.on, true); assert.equal(A.SRV.first, true);
  await A.settle();
  const st = (await api(jar, 'GET', '/api/state')).body;
  assert.equal(st.empty, false);
  assert.equal(st.collections.rooms.records.length, A.run('D.rooms.length'));
  assert.ok(st.collections['obj:cfg'] && st.collections['obj:meta'] && st.collections.items.records.length > 5);
  assert.ok(A.run('D.rooms.every(r=>r._id)'));
  assert.equal(A.run('SRV.dirty'), false);
});
test('a second computer sees exactly the same data (nothing came from the browser)', async () => {
  B = mkClient(adminJar); await B.settle();
  assert.equal(B.run('D.rooms.length'), A.run('D.rooms.length')); assert.equal(B.run('D.items.length'), A.run('D.items.length'));
  assert.equal(B.run('JSON.stringify(D.cfg)'), A.run('JSON.stringify(D.cfg)'));
  assert.equal(B.run('SRV.first'), false);
});
test('document numbers come from the server and never repeat across computers', async () => {
  const a = A.run("nextNo('RCT')"), b = B.run("nextNo('RCT')"), c = A.run("nextNo('RCT')");
  assert.deepEqual([a, b, c], ['RCT-00001', 'RCT-00002', 'RCT-00003']);
});
test('changes made on one computer reach the other; simultaneous edits are detected', async () => {
  A.run("D.rooms[0].status='Occupied'; save()"); await A.settle();
  await B.run('srvPull()'); assert.equal(B.run('D.rooms[0].status'), 'Occupied');
  A.run("D.rooms[1].status='Dirty'; save()"); B.run("D.rooms[1].status='Maintenance'; save()");
  await A.settle(); await B.settle();                                                                // B loses: A saved first
  assert.equal(B.run('D.rooms[1].status'), 'Dirty');
  const srv = (await api(adminJar, 'GET', '/api/state')).body.collections.rooms.records[1].data.status; assert.equal(srv, 'Dirty');
  A.run("D.sales.push({id:'S1',total:500,lines:[]}); save()"); await A.settle(); await B.run('srvPull()');
  assert.equal(B.run('D.sales.length'), 1);
  B.run("D.sales.splice(0,1); save()"); await B.settle(); await A.run('srvPull()'); assert.equal(A.run('D.sales.length'), 0);   // deletes travel too
});
test('removing all sample records does not bring them back after a reload', async () => {
  A.run('D.guests.length=0; save()'); await A.settle();
  const C = mkClient(adminJar); assert.equal(C.run('D.guests.length'), 0); assert.ok(C.run('D.rooms.length') > 0);
});
test('cashier: baseline migrations are not pushed; forbidden changes are undone; sales are saved', async () => {
  const mk = await api(adminJar, 'POST', '/api/admin/users', { username: 'cash1', role: 'Cashier', display: 'Cash One' });
  const jar = await loginJar('cash1', mk.body.temp_password, 'Cashier#Pass-12');
  const before = (await api(adminJar, 'GET', '/api/admin/audit?limit=1000')).body.rows.filter(r => r.action === 'write_denied').length;
  const K = mkClient(jar); assert.equal(K.SRV.me.role, 'Cashier'); assert.equal(K.run('D.users.some(u=>u.name=="cash1")'), true);
  await K.settle();
  const after1 = (await api(adminJar, 'GET', '/api/admin/audit?limit=1000')).body.rows.filter(r => r.action === 'write_denied').length; const den=(await api(adminJar, 'GET', '/api/admin/audit?limit=5&action=write_denied')).body.rows; assert.equal(after1, before, JSON.stringify(den.slice(0,2)));
  K.run("D.cfg.name='HACKED'; save()"); await K.settle();
  assert.notEqual(K.run('D.cfg.name'), 'HACKED');                                                    // reverted from the server
  assert.notEqual((await api(adminJar, 'GET', '/api/state')).body.collections['obj:cfg'].records[0].data.name, 'HACKED');
  K.run("D.sales.push({id:'S2',total:900,lines:[]}); save()"); await K.settle();
  assert.equal((await api(adminJar, 'GET', '/api/state')).body.collections.sales.records.length, 1);
  assert.equal(K.run('SRV.me.admin'), false);
});
test('licence lock makes the system read-only for the customer but not the developer', async () => {
  const dj = await loginJar('edbis', 'Dev!Start-2026-xx', 'Dev#Changed-77aa'); const D1 = mkClient(dj);
  D1.run("D.lic.expiry='2020-01-01'; D.lic.grace=1; save()"); await D1.settle();
  assert.equal((await api(adminJar, 'GET', '/api/state')).body.collections['obj:lic'].records[0].data.expiry, '2020-01-01');
  A.run("D.rooms[2].status='Dirty'; save()"); await A.settle(); assert.notEqual(A.run('D.rooms[2].status'), 'Dirty');
  D1.run("D.rooms[2].status='Dirty'; save()"); await D1.settle(); assert.equal((await api(dj, 'GET', '/api/state')).body.collections.rooms.records[2].data.status, 'Dirty');
  D1.run("D.lic.expiry='2099-01-01'; save()"); await D1.settle();
  A.run("D.rooms[3].status='Dirty'; save()"); await A.settle(); assert.equal(A.run('D.rooms[3].status'), 'Dirty');
});
test('backup includes counters; restore goes through the server', async () => {
  const bk = JSON.parse(A.run('bkJson()')); assert.ok(bk.n.RCT >= 3); assert.ok(!bk.users); assert.ok(bk.rooms.length > 0);
  A.run('PER=' + JSON.stringify({ ...bk, items: bk.items.slice(0, 3) })); await A.run('rsDo()'); await sleep(300);
  assert.equal((await api(adminJar, 'GET', '/api/state')).body.collections.items.records.length, 3);
  assert.equal((await api(adminJar, 'POST', '/api/numbers/next', { prefix: 'RCT' })).body.n >= 4, true);
    A = mkClient(adminJar); await A.settle();                                                          // the page reloads after a restore
});
test('user administration screens and login call the server', async () => {
  const U = mkClient(adminJar); await U.run('usersLoad()'); assert.ok(U.run('SRV.ulist.users.length') >= 3);
  assert.match(U.run('V.users()'), /Add user/); assert.match(U.run('V.chpw()'), /Change My Password/);
  await U.run('seclogLoad()');
});
test('losing the connection keeps the changes and retries', async () => {
  A.run("D.rooms[4].status='Dirty'; save()");
  const real = A.sb.fetch; A.sb.fetch = () => Promise.reject(new Error('offline')); await sleep(10); A.timers.splice(0).forEach(f => f()); await sleep(100);
  assert.equal(A.run('SRV.dirty'), true); assert.ok(A.run('SRV.fail') >= 1);
  A.sb.fetch = real; A.run('SRV.fail=0'); await A.run('srvSync()'); await sleep(200);
  assert.equal(A.run('SRV.dirty'), false); assert.equal((await api(adminJar, 'GET', '/api/state')).body.collections.rooms.records[4].data.status, 'Dirty');
});

/* ---------- server-side billing, relay and PIN, driven through the real screen functions ---------- */
const stripFl = r => (r.fl || []).map(e => [e.date, e.type, e.desc, e.amt, e.by, !!e.auto].join('|')).sort();
test('server room billing gives exactly what the browser calculation gives', async () => {
  const X = mkClient(adminJar);
  X.run("D.rm.post='00:00'; D.rpr.length=0; D.rpr.push({cat:'All',kind:'%',val:10,from:addD(today(),-30),to:addD(today(),30)},{cat:'All',kind:'+',val:250,from:addD(today(),-1),to:addD(today(),-1)});" +
    "D.resv.push({id:'RES-P1',guest:'Parity',room:D.rooms[0].no,in:addD(today(),-3),out:addD(today(),2),st:'In-House',rate:6000,adults:1,plan:'BB',fl:[],posted:[]});" +
    "D.resv.push({id:'RES-P2',guest:'NoSeason',room:D.rooms[1].no,in:addD(today(),-2),out:addD(today(),2),st:'In-House',rate:7000,nopr:true,adults:2,plan:'HB',fl:[],posted:[]});" +
    "D.resv.push({id:'RES-P4',guest:'Part',room:D.rooms[2].no,in:addD(today(),-3),out:addD(today(),2),st:'In-House',rate:5200,adults:1,plan:'RO',fl:[{id:'x',date:addD(today(),-3),type:'Room',amt:5720}],posted:[addD(today(),-3)]});save()");
  await X.settle();
  const L = mkClient(adminJar);                                           // a copy loaded before the server posts anything
  L.run('SRV.on=false'); const localN = L.run('runPost(1)'); assert.ok(localN >= 6);
  const r = await api(adminJar, 'POST', '/api/billing/run'); assert.equal(r.status, 200); assert.equal(r.body.n, localN);
  const srv = (await api(adminJar, 'GET', '/api/state')).body.collections.resv.records.map(x => x.data);
  let compared = 0;
  for (const lr of L.run('D.resv').filter(x => x.st === 'In-House')) { const sr = srv.find(x => x.id === lr.id); assert.ok(sr, lr.id); assert.deepEqual(stripFl(sr), stripFl(lr), lr.id); assert.deepEqual([...sr.posted].sort(), [...lr.posted].sort(), lr.id); compared++; }
  assert.ok(compared >= 3);
});
test('screens: automatic browser billing is off; "Run billing now" uses the server', async () => {
  await api(adminJar, 'POST', '/api/sync', { ops: [{ c: 'resv', id: 'p3', ver: null, data: { id: 'RES-P3', guest: 'Late', room: '999', in: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), out: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), st: 'In-House', rate: 4000, adults: 1, plan: 'RO', fl: [], posted: [] } }] });
  const X = mkClient(adminJar);
  assert.equal(X.run('runPost()'), 0); assert.equal(X.run("D.resv.find(r=>r.id=='RES-P3').posted.length"), 0);                // browser never posts by itself
  await X.run('runBillNow()');
  assert.equal(X.run("D.resv.find(r=>r.id=='RES-P3').posted.length"), 2);                                                          // posted by the server, then pulled in
});
test('screens: SMS and STK go through the server relay and the key never reaches the browser', async () => {
  const calls = [];
  const gw = http.createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { calls.push({ url: q.url, auth: q.headers.authorization, body: JSON.parse(b) }); s.writeHead(200); s.end('{}'); }); });
  await new Promise(r => gw.listen(0, '127.0.0.1', r)); const url = 'http://127.0.0.1:' + gw.address().port;
  try {
    const X = mkClient(adminJar);
    X.run("D.smsc.on=true; D.smsc.url='" + url + "/sms'; D.smsc.key='K1'; D.smsc.sender='SAIWA'; D.pay.gw={on:true,url:'" + url + "/stk',key:'K2'}; save()"); await X.settle();
    const Y = mkClient(adminJar); assert.equal(Y.run('D.smsc.key'), '********'); assert.equal(Y.run('D.pay.gw.key'), '********');
    Y.run("D.sms.push({no:'M1',to:'254711111111',msg:'Hello guest',st:'Queued'}); D.sms.push({no:'M2',to:'bad',msg:'x',st:'Queued'})");
    await Y.run('smsPush(true)'); await Y.settle();
    assert.deepEqual([...Y.run("D.sms.filter(m=>m.no=='M1'||m.no=='M2').map(m=>m.st+(m.err?':'+m.err:''))")], ['Sent', 'Failed:Invalid number']);
    const c = calls.find(x => x.url === '/sms'); assert.equal(c.auth, 'Bearer K1'); assert.equal(c.body.message, 'Hello guest'); assert.equal(c.body.from, 'SAIWA');
    await Y.run("stkPush('0711222333',1500,'INV-9')"); await Y.settle();
    assert.equal(Y.run('D.stk[D.stk.length-1].st'), 'Sent'); const k = calls.find(x => x.url === '/stk'); assert.equal(k.auth, 'Bearer K2'); assert.deepEqual([k.body.phone, k.body.amount, k.body.reference], ['254711222333', 1500, 'INV-9']);
    // editing and re-saving the settings with the masked key must not damage the stored key
    Y.run("D.smsc.sender='SAIWA2'; save()"); await Y.settle(); calls.length = 0;
    await Y.run("D.sms.push({no:'M3',to:'254733333333',msg:'again',st:'Queued'}); smsPush(true)"); assert.equal(calls[0].auth, 'Bearer K1'); assert.equal(calls[0].body.from, 'SAIWA2');
  } finally { gw.close(); }
});
test('screens: clock-in PIN is set and checked by the server', async () => {
  const X = mkClient(adminJar);
  X.run("D.staff.push({id:'e-e2e',name:'E2E Staff',dept:'Front',salary:1000}); save()"); await X.settle();
  X.run("pinF(D.staff.findIndex(s=>s.id=='e-e2e'))"); await X.run("FCB({pin:'482915'})");
  assert.equal(X.run("D.staff.find(s=>s.id=='e-e2e').pinh"), 'set');
  assert.deepEqual({ ...(await X.run("pinCheck('e-e2e','482915')")) }, { ok: true, weak: false }); await X.settle();
  const bad = await X.run("pinCheck('e-e2e','111222')"); assert.equal(bad.ok, false); assert.match(bad.msg, /attempts? left/);
  const st = JSON.stringify((await api(adminJar, 'GET', '/api/state')).body); assert.ok(!/pinh":"[0-9a-f]{64}/.test(st));
  const Y = mkClient(adminJar); assert.equal(Y.run("D.staff.find(s=>s.id=='e-e2e').pinh"), 'set'); assert.deepEqual({ ...(await Y.run("pinCheck('e-e2e','482915')")) }, { ok: true, weak: false });
  for (let i = 0; i < 5; i++) await Y.run("pinCheck('e-e2e','999000')");
  assert.match((await Y.run("pinCheck('e-e2e','482915')")).msg, /locked/);
  await Y.run("pinUnlock(D.staff.findIndex(s=>s.id=='e-e2e'))"); assert.equal((await Y.run("pinCheck('e-e2e','482915')")).ok, true);
});

/* ---------- Expenses & Accounts, Pay Bills and Unmatched M-Pesa, several people on several computers ---------- */
async function mkJar(name, role) { const r = (await api(adminJar, 'POST', '/api/admin/users', { username: name, role, display: name })).body; return loginJar(name, r.temp_password, 'Staff#Pass-2026!'); }
const as = (c, name, role) => { c.run(`USR={name:'${name}',role:'${role}'}`); return c; };
test('expenses, accruals and journals are saved to the database and seen everywhere', async () => {
  const X = as(mkClient(adminJar), 'admin', 'Admin');
  const vno = X.run("expPost({acct:'5150',amt:2320,vat:320,m:'Cash',bank:'Main Cash',date:today(),desc:'Fuel',supplier:'Shell'}).rec.vno");
  assert.match(vno, /^EXP-\d{5}$/);                                                                 // numbered by the server
  X.run("jnlPost({date:today(),ref:'E2E',memo:'test',lines:[{acct:'5130',dr:500},{acct:'3000',cr:500}]})");
  X.run("obPost({acct:'1000',dr:1000,date:today(),memo:'cash float'})"); X.run("D.budgets.push({id:'bb1',year:2026,month:0,acct:'5150',amt:12000,dept:''}); save()");
  await X.settle();
  const col = (await api(adminJar, 'GET', '/api/state')).body.collections;
  assert.ok(col.expenses.records.some(r => r.data.vno === vno) && col.gj.records.length >= 1 && col.openbal.records.length >= 1 && col.budgets.records.length >= 1);
  const Y = as(mkClient(adminJar), 'admin', 'Admin');
  assert.equal(Y.run("r2(ledger()['5150'])"), X.run("r2(ledger()['5150'])")); assert.equal(Y.run("jnlAll().length"), X.run("jnlAll().length"));
  assert.ok(Y.run("D.coa.some(a=>a.code=='5280')&&D.accounts.some(a=>a.name=='Main Cash')"));
  assert.equal(Y.run("Math.abs(Object.values(ledger()).reduce((a,b)=>a+b,0))<0.01"), true);
});
test('Pay Bills: withholding tax, and a cheque needs a second administrator', async () => {
  const j2 = await mkJar('boss2', 'Admin'), X = as(mkClient(adminJar), 'admin', 'Admin');
  X.run("D.suppliers.push({name:'SOKO Purchases',terms:14,wht:2,whv:0,pin:'P0123'}); save()");
  const id = X.run("expPost({accr:true,acct:'5130',amt:11600,vat:1600,supplier:'SOKO Purchases',date:today(),invno:'INV-9'}).rec.id");
  X.run("D.purchases.push({date:today(),supplier:'SOKO Purchases',item:'Maize',qty:10,amt:5000}); save()"); await X.settle();
  const r = X.run("(()=>{let q=supPay({date:today(),m:'Cheque',ref:'000777',bank:'Main Cash',lines:[{k:'E'+" + JSON.stringify(id) + ",amt:5800}]});return [!!q.queued,q.recs[0].no,q.recs[0].wht,q.recs[0].cash]})()");
  assert.deepEqual([...r], [true, 'CHQ-00001', 100, 5700]); await X.settle();
  assert.equal(X.run("D.spq[0].st"), 'Pending'); assert.equal(X.run("supBal('SOKO Purchases')"), 16600);
  assert.match(X.run("spqDecide(D.spq[0].id,'approve').err"), /different administrator/);
  const Z = as(mkClient(j2), 'boss2', 'Admin'); assert.equal(Z.run("D.spq.length"), 1);
  assert.equal(Z.run("spqDecide(D.spq[0].id,'approve').ok"), 1); await Z.settle();
  const st = (await api(adminJar, 'GET', '/api/state')).body.collections; assert.equal(st.paysupp.records.length, 1); assert.equal(st.paysupp.records[0].data.wht, 100); assert.match(st.paysupp.records[0].data.appr, /boss2/);
  await X.run('srvPull()'); assert.equal(X.run("supBal('SOKO Purchases')"), 16600 - 5800); assert.equal(X.run("r2(ledger()['2110'])"), -100);
});
test('Unmatched M-Pesa: cashier requests, a second administrator approves, everyone sees it; races and reversals hold', async () => {
  const jc = await mkJar('cashE', 'Cashier'), jc2 = await mkJar('cashF', 'Cashier'), j2 = await mkJar('boss3', 'Admin');
  const X = as(mkClient(adminJar), 'admin', 'Admin');
  X.run("D.resv.push({id:'RES-E1',guest:'JOHN DOE',room:'7',in:today(),out:addD(today(),2),st:'In-House',rate:5000,adults:1,plan:'RO',fl:[{id:'e1',date:today(),type:'Extra',desc:'Dinner',amt:3000,cat:'Restaurant'}],posted:[]}); save()"); await X.settle();
  const K = as(mkClient(jc), 'cashE', 'Cashier'); K.run("mpAddCredit({ref:'E2E1',amt:5000,name:'JOHN DOE',date:today()}); mpAddCredit({ref:'E2E2',amt:4000,name:'MARY',date:today()})"); await K.settle();
  assert.equal(K.run("D.mpu.length"), 2); const K2 = as(mkClient(jc2), 'cashF', 'Cashier');          // loaded BEFORE the first request: still thinks 5,000 is free
  assert.equal(K2.run("mpAvail(D.mpu.find(p=>p.ref=='E2E1')).avail"), 5000);
  const pid = K.run("D.mpu.find(p=>p.ref=='E2E1').id");
  const q1 = await K.run(`mpRequest({type:'folio',id:'RES-E1',evidence:'Paid as JOHN DOE, SMS E2E1',allocs:[{pid:'${pid}',amt:3000}]})`); assert.ok(q1.rec); assert.equal(K.run("D.mps[0].st"), 'Pending'); assert.equal(K.run("D.mps[0].no"), 'MPS-00001');
  const q2 = await K2.run(`mpRequest({type:'customer',id:'Safari Tours Ltd',evidence:'Safari Tours paid per statement E2E1',allocs:[{pid:'${pid}',amt:3000}]})`);
  assert.match(q2.err, /only 2000\.00 available|only 2,000/); assert.equal(K2.run("D.mps.length"), 0);                    // server refused: the money is held by the first request
  assert.match(await K.run("mpDecide(D.mps[0].id,'approve').then(r=>r.err)"), /Administrator|different/);
  const Z = as(mkClient(j2), 'boss3', 'Admin'); assert.equal(Z.run("D.mps[0].st"), 'Pending');
  const ap = await Z.run("mpDecide(D.mps[0].id,'approve')"); assert.equal(ap.ok, 1); assert.equal(Z.run("D.mps[0].st"), 'Approved'); assert.equal(Z.run("D.mps[0].posted"), true); await Z.settle();
  const srv = (await api(adminJar, 'GET', '/api/state')).body.collections;
  const folio = srv.resv.records.find(r => r.data.id === 'RES-E1').data; const e = folio.fl.find(x => x.mps); assert.ok(e && e.amt === 3000 && e.ref === 'E2E1' && e.m === 'M-Pesa' && /^RCT-/.test(e.no));
  await K.run('srvPull()'); assert.equal(K.run("folBal(D.resv.find(r=>r.id=='RES-E1'))"), 0); assert.equal(K.run("mpAvail(D.mpu.find(p=>p.ref=='E2E1')).avail"), 2000);
  assert.equal(K.run("r2(ledger()['2250'])"), -(9000 - 3000)); assert.equal(Z.run("r2(ledger()['2250'])"), -(9000 - 3000));
  // reversal by an administrator: money back in Unmatched, folio owes again, on every screen
  await X.run('srvPull()'); const rv = await X.run("mpReverse(D.mps[0].id,'Paid for another guest')"); assert.equal(rv.ok, 1); await X.settle();
  await K.run('srvPull()'); assert.equal(K.run("folBal(D.resv.find(r=>r.id=='RES-E1'))"), 3000); assert.equal(K.run("mpAvail(D.mpu.find(p=>p.ref=='E2E1')).avail"), 5000); assert.equal(K.run("r2(ledger()['2250'])"), -9000);
  // approver's computer closed before posting: the next administrator screen completes it
  const q3 = await K.run(`mpRequest({type:'folio',id:'RES-E1',evidence:'Paid as JOHN DOE, second SMS E2E1',allocs:[{pid:'${pid}',amt:3000}]})`); assert.ok(q3.rec);
  const id3 = K.run("D.mps[D.mps.length-1].id"); const dec = await api(j2, 'POST', '/api/mpesa/decide', { id: id3, action: 'approve' }); assert.equal(dec.status, 200);   // approved on the server only
  await X.run('srvPull()'); await X.settle();
  assert.equal(X.run(`D.mps.find(r=>r.id=='${id3}').posted`), true); assert.equal(X.run("folBal(D.resv.find(r=>r.id=='RES-E1'))"), 0);
  const after = (await api(adminJar, 'GET', '/api/state')).body.collections.resv.records.find(r => r.data.id === 'RES-E1').data; assert.equal(after.fl.filter(x => x.mps && !x.rv && x.amt > 0 && x.id.includes(id3)).length, 1);
  assert.equal(X.run("Math.abs(Object.values(ledger()).reduce((a,b)=>a+b,0))<0.01"), true);
});
test('statement import and register work in server mode', async () => {
  const jc = await mkJar('cashG', 'Cashier'), A0 = as(mkClient(adminJar), 'admin', 'Admin'); A0.run("D.cfg.name='Saiwa Safari Resort'; save()"); await A0.settle();
  const K = as(mkClient(jc), 'cashG', 'Cashier');
  const sum = K.run("mpImportText('Receipt No.,Completion Time,Details,Paid In,Withdrawn\\nIMP1,2026-10-11 09:15:01,Funds received from 254711000111 - PETER K,2500,\\nIMP2,2026-10-11 09:16:00,Funds received from Saiwa Safari Resort,807283,\\nIMP3,2026-10-11 09:17:00,Withdrawal to till,,354961')"); await K.settle();
  assert.deepEqual([sum.added, sum.internal, sum.debits], [2, 1, 1]);
  const mp = (await api(adminJar, 'GET', '/api/state')).body.collections.mpu.records.map(r => r.data);
  assert.equal(mp.find(p => p.ref === 'IMP1').tag, 'Customer'); assert.equal(mp.find(p => p.ref === 'IMP2').tag, 'Internal'); assert.equal(mp.find(p => p.ref === 'IMP1').name, 'PETER K');
  const again = K.run("mpImportText('Receipt No.,Completion Time,Details,Paid In\\nIMP1,2026-10-11 09:15:01,Funds received from PETER K,2500')"); assert.equal(again.dup, 1);
  const Y = as(mkClient(adminJar), 'admin', 'Admin'); assert.match(Y.run("V.mpu()"), /IMP1/); assert.match(Y.run("V.mpset()"), /Find the payment/); assert.match(Y.run("V.mpreq()"), /M-Pesa Settlement Requests/);
});
