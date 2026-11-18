'use strict';
// Tests that are specific to the Cloudflare edition (they run in plain Node, no Cloudflare account needed).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { createAdapter } = require('../cf/sql-adapter');
const bridge = require('./cf-bridge');
const tz = require('../src/tz');
process.env.ECBS_TARGET = 'cf';
const H = require('./helpers');

test('schema string used on Cloudflare is in sync with db/schema.sqlite.sql (run: node scripts/gen-schema.js)', () => {
  assert.equal(require('../src/schema-sqlite'), fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sqlite.sql'), 'utf8'));
});

test('hotel time zone does not depend on the machine clock zone', () => {
  assert.deepEqual(tz.parts(new Date('2026-10-31T21:30:00Z'), 'Africa/Nairobi'), { date: '2026-11-01', hm: '00:30', hms: '00:30:00' });
  assert.equal(tz.parts(new Date('2026-10-31T02:30:00Z'), 'Africa/Nairobi').hm, '05:30');
  assert.equal(tz.parts(new Date('2026-10-31T00:05:09Z'), 'UTC').hms, '00:05:09');
});

function freshAdapter(opts) {
  const sql = bridge.mockSql(), a = createAdapter(sql, { log: () => {}, ...opts });
  return { sql, a };
}
async function seeded() {
  const { sql, a } = freshAdapter();
  await a.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sqlite.sql'), 'utf8'));
  assert.equal(await a.enableUndo(), true, 'undo journal triggers should install');
  await a.q('INSERT INTO tenants(id,name,rev,created_at) VALUES(?,?,?,?)', ['t1', 'T1', 5, 1]);
  await a.q("INSERT INTO sequences(tenant_id,prefix,n) VALUES('t1','A',1),('t1','B',2)");
  return { sql, a };
}
const snap = async a => JSON.stringify([await a.q('SELECT * FROM tenants ORDER BY id'), await a.q('SELECT * FROM sequences ORDER BY prefix')]);

test('a failed transaction is rolled back (inserts, updates and deletes)', async () => {
  const { a } = await seeded(), before = await snap(a);
  await assert.rejects(a.tx(async t => {
    await t.q("INSERT INTO sequences(tenant_id,prefix,n) VALUES('t1','C',9)");
    await t.q("UPDATE sequences SET n=n+100 WHERE prefix='A'");
    await t.q("DELETE FROM sequences WHERE prefix='B'");
    await t.q('UPDATE tenants SET rev=rev+1 WHERE id=?', ['t1']);
    await t.q("INSERT INTO sequences(tenant_id,prefix,n) VALUES('t1','D',1) ON CONFLICT(tenant_id,prefix) DO UPDATE SET n=sequences.n+1");
    await t.q("INSERT INTO sequences(tenant_id,prefix,n) VALUES('t1','A',1) ON CONFLICT(tenant_id,prefix) DO UPDATE SET n=sequences.n+1");
    throw new Error('boom');
  }), /boom/);
  assert.equal(await snap(a), before);
  assert.equal((await a.q('SELECT COUNT(*) c FROM ecbs_undo'))[0].c, 0);
});

test('a successful transaction commits and later work is unaffected', async () => {
  const { a } = await seeded();
  const rev = await a.tx(async t => { await t.q("UPDATE sequences SET n=50 WHERE prefix='A'"); return (await t.q('UPDATE tenants SET rev=rev+1 WHERE id=? RETURNING rev', ['t1']))[0].rev; });
  assert.equal(rev, 6);
  assert.equal((await a.q("SELECT n FROM sequences WHERE prefix='A'"))[0].n, 50);
  await assert.rejects(a.tx(async t => { await t.q("UPDATE sequences SET n=1 WHERE prefix='A'"); throw new Error('x'); }));
  assert.equal((await a.q("SELECT n FROM sequences WHERE prefix='A'"))[0].n, 50, 'rollback restores the committed value');
});

test('special characters and NULLs survive a rollback', async () => {
  const { a } = await seeded();
  await a.q("INSERT INTO users(id,tenant_id,username,display,role,pw_hash,active,must_change,created_at) VALUES('u1','t1','o''brien','Zoë \"Q\" ''x''','Admin',NULL,1,0,1)");
  const before = JSON.stringify(await a.q('SELECT * FROM users'));
  await assert.rejects(a.tx(async t => { await t.q("UPDATE users SET display='gone', pw_hash='h' WHERE id='u1'"); await t.q("DELETE FROM users WHERE id='u1'"); throw new Error('x'); }));
  assert.equal(JSON.stringify(await a.q('SELECT * FROM users')), before);
});

test('a transaction interrupted by a crash is rolled back when the object restarts', async () => {
  const { sql, a } = await seeded(), before = await snap(a);
  sql.raw.exec("UPDATE ecbs_undo_on SET active=1");                       // what the database looks like in the middle of a transaction ...
  sql.raw.exec("UPDATE sequences SET n=999 WHERE prefix='A'; INSERT INTO sequences(tenant_id,prefix,n) VALUES('t1','Z',1)");   // ... with some writes already made
  const restarted = createAdapter({ exec: sql.exec, raw: sql.raw }, { log: () => {} });                                         // a new object over the same storage
  await restarted.enableUndo();
  assert.equal(await snap(restarted), before);
});

test('transactions run one at a time', async () => {
  const { a } = await seeded(); const order = [];
  await Promise.all([1, 2, 3].map(i => a.tx(async t => { order.push('s' + i); await t.q("UPDATE sequences SET n=n+1 WHERE prefix='A'"); await new Promise(r => setImmediate(r)); order.push('e' + i); })));
  assert.deepEqual(order, ['s1', 'e1', 's2', 'e2', 's3', 'e3']);
});

test('without the journal the adapter still works (no rollback)', async () => {
  const { a } = freshAdapter({ undo: false });
  await a.exec('CREATE TABLE x(a INTEGER);');
  await a.tx(async t => { await t.q('INSERT INTO x VALUES(1)'); });
  assert.equal((await a.q('SELECT COUNT(*) c FROM x'))[0].c, 1);
});

before(async () => { await H.up(); });
after(async () => { await H.down(); });

test('operator endpoint creates a hotel\'s first user; wrong or missing token is refused', async () => {
  const call = (token, body, tenant = 'tenantb') => bridge.state.worker.default.fetch(new Request('http://localhost/_ops/user?tenant=' + tenant, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }), bridge.state.env);
  delete process.env.OPS_TOKEN;
  assert.equal((await call('x'.repeat(20), { username: 'boss', role: 'Admin' })).status, 404, 'disabled until OPS_TOKEN is set');
  process.env.OPS_TOKEN = 'ops-token-for-tests-0123456789';
  assert.equal((await call('wrong-token-wrong-token-wrong', { username: 'boss', role: 'Admin' })).status, 401);
  assert.equal((await call(null, { username: 'boss', role: 'Admin' })).status, 401);
  const r = await call(process.env.OPS_TOKEN, { username: 'boss', role: 'Admin' });
  assert.equal(r.status, 200); const j = await r.json(); assert.ok(j.temp_password && j.temp_password.length >= 12);
  assert.equal((await call(process.env.OPS_TOKEN, { username: 'boss', role: 'Admin' })).status, 409);
  assert.equal((await call(process.env.OPS_TOKEN, { username: 'boss', role: 'Nonsense' })).status, 400);
  const c = new H.Client('other.test'); const lg = await c.login('boss', j.temp_password); assert.equal(lg.status, 200); assert.equal(lg.body.user.must_change, true);
  delete process.env.OPS_TOKEN;
});

test('the Durable Object alarm runs billing and re-arms itself', async () => {
  assert.equal((await new H.Client().call('GET', '/healthz')).status, 200);        // wakes the default hotel's object
  const obj = bridge.state.objects.get('default'); assert.ok(obj);
  process.env.BILLING_TIMER = 'on'; bridge.state.alarm = null;
  await obj.alarm();
  assert.ok(bridge.state.alarm > Date.now() && bridge.state.alarm <= Date.now() + 61000, 'next alarm in about a minute');
  process.env.BILLING_TIMER = 'off';
});

test('large request bodies are refused before they are read', async () => {
  const r = await bridge.state.worker.default.fetch(new Request('http://localhost/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(500 * 1048576) }, body: '{}' }), bridge.state.env);
  assert.equal(r.status, 413);
});
