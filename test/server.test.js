'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { up, down, Client, db, sync, up1 } = require('./helpers');
let admin, dev;
const ADMIN_PW = 'Adm1n!Start-2026', NEW_PW = 'Better#Pass-9981';
test.before(async () => { await up(); });
test.after(async () => { await down(); });

test('health, static page and security headers', async () => {
  const c = new Client();
  const h = await c.call('GET', '/healthz'); assert.equal(h.status, 200);
  const i = await c.call('GET', '/'); assert.equal(i.status, 200);
  for (const k of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy']) assert.ok(i.headers[k], k);
  assert.match(i.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await c.call('GET', '/etc/passwd')).status, 404);
  assert.equal((await c.call('GET', '/api/state')).status, 401);
  assert.equal((await c.call('GET', '/api/nothing')).status, 404);
});

test('login: generic errors, hashed passwords, lockout', async () => {
  const c = new Client();
  const a = await c.login('admin', 'wrong-password'), b = await c.login('nobody', 'wrong-password');
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.body.error, b.body.error);
  const row = (await db.q("SELECT pw_hash FROM users WHERE username='admin'"))[0];
  assert.match(row.pw_hash, /^scrypt\$/); assert.ok(!row.pw_hash.includes('Adm1n'));
  for (let i = 0; i < 4; i++) await c.login('lockme', 'x' + i);
  const l = await c.login('lockme', 'x5'); assert.equal(l.status, 401);   // 5th failure triggers the lock
  const l2 = await c.login('lockme', 'x6'); assert.equal(l2.status, 429);
  const au = await db.q("SELECT action FROM audit_log WHERE action='login_failed'"); assert.ok(au.length >= 6);
});

test('first login forces a password change; policy enforced; sessions revoked', async () => {
  admin = new Client(); const r = await admin.login('admin', ADMIN_PW);
  assert.equal(r.status, 200); assert.equal(r.body.user.must_change, true); assert.ok(r.headers['set-cookie'][0].includes('HttpOnly')); assert.ok(r.headers['set-cookie'][0].includes('SameSite=Strict'));
  const blocked = await admin.call('GET', '/api/state'); assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'password_change_required');
  assert.equal((await admin.call('GET', '/api/me')).status, 200);
  assert.equal((await admin.call('POST', '/api/change-password', { old: ADMIN_PW, new: 'short' })).status, 400);
  assert.equal((await admin.call('POST', '/api/change-password', { old: ADMIN_PW, new: 'password123' })).status, 400);
  assert.equal((await admin.call('POST', '/api/change-password', { old: 'bad', new: NEW_PW })).status, 400);
  assert.equal((await admin.call('POST', '/api/change-password', { old: ADMIN_PW, new: NEW_PW })).status, 200);
  assert.equal((await admin.call('GET', '/api/state')).status, 200);
  const again = new Client(); assert.equal((await again.login('admin', ADMIN_PW)).status, 401); assert.equal((await again.login('admin', NEW_PW)).status, 200);
  dev = new Client(); await dev.login('edbis', 'Dev!Start-2026-xx'); await dev.call('POST', '/api/change-password', { old: 'Dev!Start-2026-xx', new: 'Dev#Changed-77aa' });
});

test('CSRF, origin check, logout', async () => {
  const c = new Client(); await c.login('admin', NEW_PW);
  assert.equal((await c.call('POST', '/api/sync', { ops: [] }, { nocsrf: true })).status, 403);
  assert.equal((await c.call('POST', '/api/sync', { ops: [] }, { csrf: 'x'.repeat(c.csrf.length) })).status, 403);
  assert.equal((await c.call('POST', '/api/sync', { ops: [] }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.call('POST', '/api/sync', { ops: [] }, { headers: { Origin: 'http://localhost' } })).status, 200);
  assert.equal((await c.call('POST', '/api/logout')).status, 200);
  assert.equal((await c.call('GET', '/api/state', undefined, { nocookie: true })).status, 401);
});

test('sync: insert, update, conflict, delete, idempotent retry, order', async () => {
  const s0 = (await admin.call('GET', '/api/state')).body; assert.equal(s0.empty, true);
  let r = (await sync(admin, [up1(admin, 'rooms', 'a1', { no: '1' }), up1(admin, 'rooms', 'a2', { no: '2' }), up1(admin, 'obj:cfg', 'main', { name: 'Saiwa' })])).body;
  assert.ok(r.results.every(x => x.ok && x.ver === 1));
  assert.equal((await sync(admin, [up1(admin, 'rooms', 'a1', { no: '1' })])).body.results[0].ok, true);                    // retry of the same insert
  r = (await sync(admin, [up1(admin, 'rooms', 'a1', { no: '1', st: 'x' }, 1)])).body.results[0]; assert.equal(r.ver, 2);
  r = (await sync(admin, [up1(admin, 'rooms', 'a1', { no: '1', st: 'y' }, 1)])).body.results[0];                             // stale version
  assert.equal(r.ok, false); assert.equal(r.err, 'conflict'); assert.equal(r.current.data.st, 'x'); assert.equal(r.current.ver, 2);
  r = (await sync(admin, [{ c: 'rooms', id: 'a2', ver: 1, del: true }])).body.results[0]; assert.equal(r.ok, true);
  const st = (await admin.call('GET', '/api/state')).body;
  assert.deepEqual(st.collections.rooms.records.map(x => x.id), ['a1']); assert.equal(st.collections['obj:cfg'].kind, 'obj');
  r = (await sync(admin, [up1(admin, 'rooms', 'a2', { no: '2b' })])).body.results[0]; assert.equal(r.ok, true);              // re-create a deleted id
  assert.deepEqual((await admin.call('GET', '/api/state')).body.collections.rooms.records.map(x => x.id), ['a1', 'a2']);
});

test('sync validation', async () => {
  const bad = async o => (await sync(admin, [o])).body.results[0];
  assert.equal((await bad({ c: 'Bad Name', id: 'x', data: {} })).err, 'invalid');
  assert.equal((await bad({ c: 'rooms', id: '../x', data: {} })).err, 'invalid');
  assert.equal((await bad({ c: 'obj:cfg', id: 'other', data: {} })).err, 'invalid');
  assert.equal((await bad({ c: 'rooms', id: 'p1', data: JSON.parse('{"__proto__":{"admin":true}}') })).err, 'invalid');
  assert.equal((await bad({ c: 'rooms', id: 'p2', data: [1] })).err, 'invalid');
  assert.equal((await bad({ c: 'rooms', id: 'big', data: { x: 'a'.repeat(2.1 * 1048576) } })).err, 'too_large');
  assert.equal((await sync(admin, new Array(1001).fill({}))).status, 400);
  assert.equal((await admin.call('POST', '/api/sync', '{not json')).status, 400);
});

test('changes feed for multi-user refresh', async () => {
  const w = new Client(); await w.login('admin', NEW_PW);
  const base = (await admin.call('GET', '/api/state')).body.rev;
  await sync(w, [up1(w, 'items', 'i1', { name: 'Tea' })]);
  let ch = (await admin.call('GET', '/api/changes?since=' + base)).body;
  assert.equal(ch.changes.length, 1); assert.equal(ch.changes[0].c, 'items'); assert.equal(ch.changes[0].data.name, 'Tea');
  await sync(w, [{ c: 'items', id: 'i1', ver: 1, del: true }]);
  ch = (await admin.call('GET', '/api/changes?since=' + ch.rev)).body; assert.equal(ch.changes[0].deleted, true);
  assert.equal((await admin.call('GET', '/api/changes?since=99999999')).body.reset, true);
  assert.equal((await admin.call('GET', '/api/changes?since=' + ch.rev)).body.changes.length, 0);
});

test('user administration and role enforcement', async () => {
  const mk = async (u, role) => (await admin.call('POST', '/api/admin/users', { username: u, role, display: u }));
  const c1 = await mk('cashier1', 'Cashier'); assert.equal(c1.status, 201); assert.ok(c1.body.temp_password.length >= 12);
  assert.equal((await mk('cashier1', 'Cashier')).status, 409); assert.equal((await mk('x', 'Cashier')).status, 400); assert.equal((await mk('ghost', 'Nope')).status, 400);
  assert.equal((await mk('sneaky', 'Developer Super Admin')).status, 403);
  assert.equal((await mk('hrman', 'Manager')).status, 201);
  const cash = new Client(); assert.equal((await cash.login('cashier1', c1.body.temp_password)).status, 200);
  assert.equal((await cash.call('GET', '/api/state')).status, 403);
  assert.equal((await cash.call('POST', '/api/change-password', { old: c1.body.temp_password, new: 'Cashier#Pass-12' })).status, 200);
  assert.equal((await cash.call('GET', '/api/admin/users')).status, 403);
  assert.equal((await cash.call('POST', '/api/admin/import', { state: {} })).status, 403);
  // writes
  await sync(admin, [up1(admin, 'staff', 's1', { name: 'Jane', salary: 85000 }), up1(admin, 'obj:closed', 'main', { date: '' })]);
  let r = (await sync(cash, [up1(cash, 'sales', 'k1', { total: 100 }), up1(cash, 'obj:closed', 'main', { date: '2030-01-01' }, 1), up1(cash, 'staff', 's9', { name: 'x' }), up1(cash, 'roles', 'r1', { n: 1 }), up1(cash, 'audit', 'au1', { m: 'sold' })])).body.results;
  assert.deepEqual(r.map(x => x.ok), [true, false, false, false, true]); assert.equal(r[1].err, 'forbidden');
  r = (await sync(cash, [up1(cash, 'audit', 'au1', { m: 'edited' }, 1), { c: 'audit', id: 'au1', ver: 1, del: true }])).body.results; assert.ok(r.every(x => !x.ok));   // audit is append-only
  const view = (await cash.call('GET', '/api/state')).body;
  assert.equal(view.collections.staff.records[0].data.salary, 0); assert.equal(view.collections.staff.records[0].data._redacted, 1);
  assert.equal((view.collections.audit || { records: [] }).records.length, 0);
  assert.equal((await admin.call('GET', '/api/state')).body.collections.staff.records[0].data.salary, 85000);
  assert.ok((await db.q("SELECT 1 FROM audit_log WHERE action='write_denied'")).length >= 1);
  // role change and deactivation kill sessions
  const list = (await admin.call('GET', '/api/admin/users')).body.users, cu = list.find(u => u.username === 'cashier1');
  assert.equal((await admin.call('PUT', '/api/admin/users/' + cu.id, { role: 'Front Office' })).status, 200);
  assert.equal((await cash.call('GET', '/api/me')).status, 401);
  const me = list.find(u => u.username === 'admin');
  assert.equal((await admin.call('PUT', '/api/admin/users/' + me.id, { active: false })).status, 400);
  assert.equal((await admin.call('DELETE', '/api/admin/users/' + me.id)).status, 400);
  assert.equal((await admin.call('PUT', '/api/admin/users/' + me.id, { role: 'Cashier' })).status, 400);
  const devU = list.find(u => u.username === 'edbis');
  assert.equal((await admin.call('PUT', '/api/admin/users/' + devU.id, { active: false })).status, 403);
  assert.equal((await admin.call('DELETE', '/api/admin/users/' + devU.id)).status, 403);
  // reset password + unlock
  const rs = (await admin.call('PUT', '/api/admin/users/' + cu.id, { reset_password: true, unlock: true })).body; assert.ok(rs.temp_password);
  const c2 = new Client(); assert.equal((await c2.login('cashier1', rs.temp_password)).body.user.must_change, true);
  await admin.call('PUT', '/api/admin/users/' + cu.id, { active: false }); assert.equal((await new Client().login('cashier1', rs.temp_password)).status, 401);
  assert.equal((await admin.call('DELETE', '/api/admin/users/' + cu.id)).status, 200);
  const ss = (await admin.call('GET', '/api/admin/sessions')).body.sessions; assert.ok(ss.length >= 1 && ss.some(s => s.current));
  const other = ss.find(s => !s.current); if (other) assert.equal((await admin.call('DELETE', '/api/admin/sessions/' + other.id)).status, 200);
});

test('licence record is developer-only and locks writes when expired', async () => {
  assert.equal((await sync(admin, [up1(admin, 'obj:lic', 'main', { status: 'Active', expiry: '2099-01-01' })])).body.results[0].err, 'forbidden');
  assert.equal((await sync(admin, [up1(admin, 'plans', 'p1', { n: 1 })])).body.results[0].err, 'forbidden');
  const lv = async () => (await dev.call('GET', '/api/state')).body.collections['obj:lic'].records[0].ver;
  assert.equal((await dev.call('GET', '/api/state')).body.collections['obj:lic'].records[0].data.plan, 'Trial');   // created by the server, not the browser
  assert.equal((await sync(dev, [up1(dev, 'obj:lic', 'main', { status: 'Active', expiry: '2099-01-01', grace: 7 }, await lv())])).body.results[0].ok, true);
  assert.equal((await sync(admin, [up1(admin, 'rooms', 'lk1', { no: 'L' })])).body.results[0].ok, true);
  assert.equal((await sync(dev, [up1(dev, 'obj:lic', 'main', { status: 'Active', expiry: '2020-01-01', grace: 7 }, await lv())])).body.results[0].ok, true);
  let r = (await sync(admin, [up1(admin, 'rooms', 'lk2', { no: 'L2' })])).body.results[0]; assert.equal(r.err, 'license');
  assert.equal((await admin.call('GET', '/api/state')).status, 200);                           // reading still works
  assert.equal((await sync(dev, [up1(dev, 'rooms', 'lk3', { no: 'L3' })])).body.results[0].ok, true);   // developer is never locked out
  await sync(dev, [up1(dev, 'obj:lic', 'main', { status: 'Deactivated', expiry: '2099-01-01' }, await lv())]);
  assert.equal((await sync(admin, [up1(admin, 'rooms', 'lk4', { no: 'L4' })])).body.results[0].err, 'license');
  await sync(dev, [up1(dev, 'obj:lic', 'main', { status: 'Active', expiry: '2099-01-01', grace: 7 }, await lv())]);
  assert.equal((await sync(admin, [up1(admin, 'rooms', 'lk5', { no: 'L5' })])).body.results[0].ok, true);
});

test('integration secrets are encrypted at rest and hidden from non-admins', async () => {
  await sync(admin, [up1(admin, 'obj:smsc', 'main', { url: 'https://sms.example', key: 'TOP-SECRET-KEY', on: true }), up1(admin, 'obj:pay', 'main', { gw: { url: 'u', key: 'MPESA-KEY', on: true } })]);
  const raw = (await db.q("SELECT data FROM records WHERE coll IN ('obj:smsc','obj:pay')")).map(r => r.data).join('');
  assert.ok(!raw.includes('TOP-SECRET-KEY') && !raw.includes('MPESA-KEY')); assert.ok(raw.includes('enc:'));
  const st = (await admin.call('GET', '/api/state')).body.collections;
  assert.equal(st['obj:smsc'].records[0].data.key, '********'); assert.equal(st['obj:pay'].records[0].data.gw.key, '********');   // masked even for administrators
  const m = new Client(); const u = (await admin.call('POST', '/api/admin/users', { username: 'fo1', role: 'Front Office' })).body;
  await m.login('fo1', u.temp_password); await m.call('POST', '/api/change-password', { old: u.temp_password, new: 'Front#Office-4412' });
  const ms = (await m.call('GET', '/api/state')).body.collections; assert.equal(ms['obj:smsc'].records[0].data.key, '********'); assert.equal(ms['obj:pay'].records[0].data.gw.key, '********');
  const w = (await sync(admin, [up1(admin, 'obj:smsc', 'main', { url: 'https://sms.example', key: 'TOP-SECRET-KEY', on: true })])).body.results[0]; assert.ok(w.ok && w.same);   // re-sending an unchanged secret is an idempotent no-op
});

test('document numbers are atomic and unique', async () => {
  const ns = await Promise.all(Array.from({ length: 25 }, () => admin.call('POST', '/api/numbers/next', { prefix: 'INV' }).then(r => r.body.n)));
  assert.equal(new Set(ns).size, 25); assert.equal(Math.min(...ns), 1); assert.equal(Math.max(...ns), 25);
  assert.equal((await admin.call('POST', '/api/numbers/init', { counters: { INV: 10, RCT: 500 } })).status, 200);
  assert.equal((await admin.call('POST', '/api/numbers/next', { prefix: 'INV' })).body.n, 26); assert.equal((await admin.call('POST', '/api/numbers/next', { prefix: 'RCT' })).body.n, 501);
  assert.equal((await admin.call('POST', '/api/numbers/next', { prefix: 'x;drop' })).status, 400);
});

test('tenants are isolated', async () => {
  const t = new Client('other.test'); assert.equal((await t.login('admin', NEW_PW)).status, 401);     // user table is per tenant
  await db.q("INSERT INTO users(id,tenant_id,username,role,pw_hash,active,must_change,created_at) VALUES('tb1','tenantb','boss','Admin',?,1,0,1)", [(await db.q("SELECT pw_hash FROM users WHERE username='admin'"))[0].pw_hash]);
  assert.equal((await t.login('boss', NEW_PW)).status, 200);
  await sync(t, [up1(t, 'rooms', 'tb-room', { no: 'B' })]);
  const ids = id => id.collections.rooms.records.map(r => r.id);
  assert.ok(!ids((await t.call('GET', '/api/state')).body).includes('a1')); assert.ok(ids((await t.call('GET', '/api/state')).body).includes('tb-room'));
  assert.ok(!ids((await admin.call('GET', '/api/state')).body).includes('tb-room'));
  assert.equal((await t.call('GET', '/api/state', undefined, { headers: { Host: 'localhost' } })).status, 403);   // session cannot be replayed on another site
});

test('export / import (migration from the old browser-only version)', async () => {
  const legacy = { rooms: [{ no: '9', type: 'Std' }], items: [{ name: 'Soda' }, { name: 'Tea' }], cfg: { name: 'Saiwa Safari Resort' }, n: { INV: 300, RCT: 40 }, users: [{ name: 'Patrick', role: 'Manager' }, { name: 'Ager', role: 'Front Office' }, { name: 'admin', role: 'Admin' }], lic: { status: 'Active' } };
  assert.equal((await admin.call('POST', '/api/admin/import', { state: JSON.parse('{"__proto__":{"x":1}}') })).status, 400);
  const r = (await admin.call('POST', '/api/admin/import', { state: legacy })).body;
  assert.equal(r.records, 4);   // the licence record is developer-only so an admin import skips it assert.equal(r.counters, 2); assert.deepEqual(r.users_created.map(u => u.username).sort(), ['ager', 'patrick']);
  const st = (await admin.call('GET', '/api/state')).body.collections;
  assert.equal(st.rooms.records.length, 1); assert.equal(st.items.records.length, 2); assert.equal(st['obj:cfg'].records[0].data.name, 'Saiwa Safari Resort');
  assert.equal(st['obj:lic'].records[0].data.expiry, '2099-01-01');   // the developer's licence survives an admin import assert.equal(st.rooms.records[0].data._id, st.rooms.records[0].id);                     // an admin import cannot replace the licence
  assert.equal((await admin.call('POST', '/api/numbers/next', { prefix: 'INV' })).body.n, 301);
  const ex = (await admin.call('GET', '/api/admin/export')).body; assert.equal(ex.format, 'ecbs-export-1'); assert.equal(ex.collections.items.records.length, 2); assert.equal(ex.counters.INV, 301);
  const p = new Client(); assert.equal((await p.login('patrick', r.users_created[0].temp_password)).status, 200);
});

test('audit trail, record history and session expiry', async () => {
  const a = (await admin.call('GET', '/api/admin/audit?limit=500')).body.rows; const acts = new Set(a.map(x => x.action));
  for (const k of ['login', 'login_failed', 'user_created', 'password_changed', 'write_denied', 'import', 'export']) assert.ok(acts.has(k), k);
  assert.ok(!JSON.stringify(a).includes(NEW_PW));
  const h = (await admin.call('GET', '/api/admin/history?c=rooms&id=a1')).body.rows; assert.ok(h.length >= 2); assert.equal(h[0].op, 'update');
  const c = new Client(); await c.login('admin', NEW_PW); await db.q('UPDATE sessions SET last_seen=? WHERE id IN (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)', [Date.now() - 3 * 3600000]);
  const x = await c.call('GET', '/api/me'); assert.ok([200, 401].includes(x.status));
  await db.q('UPDATE sessions SET last_seen=?', [Date.now() - 3 * 3600000]); assert.equal((await c.call('GET', '/api/me')).status, 401);
});

test('roles can be tuned by the developer only', async () => {
  admin = new Client(); await admin.login('admin', NEW_PW);
  assert.equal((await admin.call('PUT', '/api/admin/roles', { roles: {} })).status, 403);
  const d = new Client(); await d.login('edbis', 'Dev#Changed-77aa');
  assert.equal((await d.call('PUT', '/api/admin/roles', { roles: { 'Bar Tender': { write: ['sales', 'trn', 'items', 'smv', 'audit'] } } })).status, 200);
  assert.equal((await d.call('PUT', '/api/admin/roles', { roles: { Bad: { write: ['x y'] } } })).status, 400);
  assert.ok((await admin.call('GET', '/api/admin/roles')).body.roles['Bar Tender']);
  assert.equal((await admin.call('POST', '/api/admin/users', { username: 'bar1', role: 'Bar Tender' })).status, 201);
});
