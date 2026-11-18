'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { up, down, Client, db, sync, up1 } = require('./helpers');
const NEW = 'Better#Pass-9981';
let admin, admin2, dev;
async function mkUser(name, role) {
  const r = (await admin.call('POST', '/api/admin/users', { username: name, role, display: name })).body, c = new Client();
  await c.login(name, r.temp_password); await c.call('POST', '/api/change-password', { old: r.temp_password, new: 'Staff#Pass-2026!' }); return c;
}
const credit = (id, ref, amt, o = {}) => ({ c: 'mpu', id, ver: null, data: { id, _id: id, ref, date: '2026-10-12', name: 'PAYER ' + ref, amt, tag: 'Customer', src: 'Manual', by: 'x', ...o } });
const state = async c => (await c.call('GET', '/api/state')).body.collections;
const T = { type: 'folio', id: 'RES-1', label: 'Room 1 – Guest', cust: 'Guest' }, EV = 'Paid under the name JOHN DOE, SMS: Confirmed SJK1 Ksh5,000';
const req = (c, allocs, o = {}) => c.call('POST', '/api/mpesa/request', { target: T, allocs, evidence: EV, ...o });
test.before(async () => {
  await up();
  admin = new Client(); await admin.login('admin', 'Adm1n!Start-2026'); await admin.call('POST', '/api/change-password', { old: 'Adm1n!Start-2026', new: NEW });
  dev = new Client(); await dev.login('edbis', 'Dev!Start-2026-xx'); await dev.call('POST', '/api/change-password', { old: 'Dev!Start-2026-xx', new: 'Dev#Changed-77aa' });
  admin2 = await mkUser('boss2', 'Admin');
});
test.after(async () => { await down(); });

test('credits: cashiers can add but not edit; duplicates and bad rows refused', async () => {
  const c1 = await mkUser('cash1', 'Cashier'), c2 = await mkUser('cash2', 'Cashier'), hk = await mkUser('hk1', 'Housekeeping');
  assert.ok((await sync(c1, [credit('p1', 'SJK1', 5000), credit('p2', 'SJK2', 4000)])).body.results.every(r => r.ok));
  assert.equal((await sync(c2, [credit('p9', 'SJK1', 777)])).body.results[0].err, 'duplicate');                // same M-Pesa ref from another till
  for (const bad of [credit('b1', 'X1', 0), credit('b2', 'X2', -5), credit('b3', '', 5), credit('b4', 'X4', 5, { tag: 'Whatever' }), credit('b5', 'X5', '100')]) assert.equal((await sync(c1, [bad])).body.results[0].err, 'invalid');
  const rec = (await state(c1)).mpu.records.find(r => r.data.id === 'p1');
  assert.equal((await sync(c1, [up1(c1, 'mpu', 'p1', { ...rec.data, amt: 99999 }, rec.ver)])).body.results[0].err, 'forbidden');   // raising a credit is blocked
  assert.equal((await sync(c1, [{ c: 'mpu', id: 'p1', ver: rec.ver, del: true }])).body.results[0].err, 'forbidden');
  assert.equal((await sync(hk, [credit('h1', 'HK1', 10)])).body.results[0].err, 'forbidden');
  assert.ok((await sync(admin, [up1(admin, 'mpu', 'p1', { ...rec.data, note: 'checked' }, rec.ver)])).body.results[0].ok);            // admin may retag / annotate
  assert.ok((await sync(c1, [credit('p3', 'SJK3', 1000, { tag: 'Internal' }), credit('p4', 'SJK4', 500)])).body.results.every(r => r.ok));
});
test('settlement and withdrawal records are admin-only; new accounting collections follow roles', async () => {
  const c1 = await mkUser('cash3', 'Cashier'), acc = await mkUser('acc1', 'Accountant');
  assert.equal((await sync(c1, [up1(c1, 'mps', 'm1', { id: 'm1', st: 'Approved', allocs: [] })])).body.results[0].err, 'forbidden');
  assert.equal((await sync(c1, [up1(c1, 'mpw', 'w1', { id: 'w1', pid: 'p1', amt: 100 })])).body.results[0].err, 'forbidden');
  assert.equal((await sync(c1, [up1(c1, 'gj', 'j1', { lines: [] })])).body.results[0].err, 'forbidden');
  for (const coll of ['gj', 'openbal', 'budgets', 'ccs', 'spq', 'expenses', 'paysupp']) assert.ok((await sync(acc, [up1(acc, coll, coll + '1', { x: 1 })])).body.results[0].ok, coll);
  assert.ok((await sync(c1, [up1(c1, 'pcr', 'pc1', { no: 'PCR-1', st: 'Pending' })])).body.results[0].ok);                              // anyone may raise a petty cash requisition
});
test('request: evidence, tags, availability and duplicates are checked on the server', async () => {
  const c1 = await mkUser('cash4', 'Cashier');
  assert.equal((await req(c1, [{ pid: 'p1', amt: 100 }], { evidence: 'short' })).status, 400);
  assert.equal((await req(c1, [{ pid: 'p3', amt: 100 }])).status, 400);                                      // internal money
  assert.equal((await req(c1, [{ pid: 'nope', amt: 100 }])).status, 404);
  assert.equal((await req(c1, [{ pid: 'p1', amt: 6000 }])).status, 409);
  assert.equal((await req(c1, [{ pid: 'p1', amt: 10 }, { pid: 'p1', amt: 10 }])).status, 400);
  assert.equal((await req(c1, [])).status, 400);
  assert.equal((await req(c1, [{ pid: 'p1', amt: 0 }])).status, 400);
  assert.equal((await c1.call('POST', '/api/mpesa/request', { target: { type: 'junk', id: 'x' }, allocs: [{ pid: 'p1', amt: 1 }], evidence: EV })).status, 400);
  const hk = await mkUser('hk2', 'Housekeeping'); assert.equal((await req(hk, [{ pid: 'p1', amt: 100 }])).status, 403);
  const ok = await req(c1, [{ pid: 'p1', amt: 2000 }, { pid: 'p2', amt: 1000 }]);
  assert.equal(ok.status, 200); const d = ok.body.record.data; assert.equal(d.st, 'Pending'); assert.equal(d.no, 'MPS-00001'); assert.equal(d.amt, 3000); assert.equal(d.by, 'cash4'); assert.deepEqual(d.allocs.map(a => [a.ref, a.amt]), [['SJK1', 2000], ['SJK2', 1000]]);
  assert.equal((await req(c1, [{ pid: 'p1', amt: 3500 }])).status, 409);                                    // only 3,000 left on p1
  assert.equal((await state(admin)).mps.records.length, 1);
  global.REQ1 = ok.body.record;
});
test('two cashiers racing for the same money: exactly one wins', async () => {
  const a = await mkUser('cash5', 'Cashier'), b = await mkUser('cash6', 'Cashier');
  assert.ok((await sync(a, [credit('r1', 'RACE1', 5000)])).body.results[0].ok);
  const res = await Promise.all([req(a, [{ pid: 'r1', amt: 3000 }]), req(b, [{ pid: 'r1', amt: 3000 }]), req(a, [{ pid: 'r1', amt: 3000 }]), req(b, [{ pid: 'r1', amt: 3000 }])]);
  assert.deepEqual(res.map(r => r.status).sort(), [200, 409, 409, 409]);
  const held = (await state(admin)).mps.records.filter(r => r.data.allocs.some(x => x.pid === 'r1')).reduce((s, r) => s + r.data.allocs[0].amt, 0); assert.equal(held, 3000);
  const ok = res.find(r => r.status === 200).body.record, rej = await admin.call('POST', '/api/mpesa/decide', { id: ok.id, action: 'reject', why: 'race test' }); assert.equal(rej.status, 200);
  assert.equal((await req(b, [{ pid: 'r1', amt: 5000 }])).status, 200);                                     // rejected request released the money
});
test('approval rules: admin only, different person, once, with reasons', async () => {
  const c1 = await mkUser('cash7', 'Cashier'), id = REQ1.id;
  assert.equal((await c1.call('POST', '/api/mpesa/decide', { id, action: 'approve' })).status, 403);
  assert.equal((await admin.call('POST', '/api/mpesa/decide', { id: 'nope', action: 'approve' })).status, 404);
  assert.equal((await admin2.call('POST', '/api/mpesa/decide', { id, action: 'reject' })).status, 400);       // reason needed
  assert.equal((await admin2.call('POST', '/api/mpesa/decide', { id, action: 'bogus' })).status, 400);
  // an administrator who raised a request cannot approve it; the developer may
  const own = await req(admin, [{ pid: 'p2', amt: 500 }]); assert.equal(own.status, 200);
  const self = await admin.call('POST', '/api/mpesa/decide', { id: own.body.record.id, action: 'approve' }); assert.equal(self.status, 403); assert.match(self.body.error, /different administrator/);
  assert.equal((await dev.call('POST', '/api/mpesa/decide', { id: own.body.record.id, action: 'approve' })).status, 200);
  const ap = await admin2.call('POST', '/api/mpesa/decide', { id, action: 'approve' }); assert.equal(ap.status, 200);
  assert.equal(ap.body.record.data.st, 'Approved'); assert.equal(ap.body.record.data.appr, 'boss2'); assert.equal(ap.body.record.ver, 2);
  assert.equal((await admin2.call('POST', '/api/mpesa/decide', { id, action: 'approve' })).status, 409);       // already decided
  assert.equal((await admin.call('POST', '/api/mpesa/decide', { id, action: 'reject', why: 'late' })).status, 409);
});
test('approval re-checks the money: a withdrawal made while pending blocks approval', async () => {
  const c1 = await mkUser('cash8', 'Cashier');
  assert.ok((await sync(c1, [credit('w1', 'WD1', 5000)])).body.results[0].ok);
  const r = await req(c1, [{ pid: 'w1', amt: 4000 }]); assert.equal(r.status, 200);
  assert.ok((await sync(admin, [up1(admin, 'mpw', 'wd1', { id: 'wd1', pid: 'w1', ref: 'WD1', amt: 2000, type: 'Refund', why: 'refund' })])).body.results[0].ok);
  const ap = await admin2.call('POST', '/api/mpesa/decide', { id: r.body.record.id, action: 'approve' }); assert.equal(ap.status, 409); assert.match(ap.body.error, /no longer has enough/);
  assert.equal((await admin2.call('POST', '/api/mpesa/decide', { id: r.body.record.id, action: 'reject', why: 'refunded instead' })).status, 200);
});
test('reversal: admin only, reason, approved only, not POS; money becomes available again', async () => {
  const c1 = await mkUser('cash9', 'Cashier');
  assert.ok((await sync(c1, [credit('v1', 'REV1', 3000)])).body.results[0].ok);
  const r = await req(c1, [{ pid: 'v1', amt: 3000 }]), id = r.body.record.id;
  assert.equal((await admin2.call('POST', '/api/mpesa/reverse', { id, why: 'x' })).status, 409);              // still pending
  await admin2.call('POST', '/api/mpesa/decide', { id, action: 'approve' });
  assert.equal((await c1.call('POST', '/api/mpesa/reverse', { id, why: 'x' })).status, 403);
  assert.equal((await admin2.call('POST', '/api/mpesa/reverse', { id, why: '' })).status, 400);
  assert.equal((await req(c1, [{ pid: 'v1', amt: 100 }])).status, 409);                                        // still used
  const rv = await admin.call('POST', '/api/mpesa/reverse', { id, why: 'wrong guest' }); assert.equal(rv.status, 200); assert.equal(rv.body.record.data.st, 'Reversed'); assert.equal(rv.body.record.data.revBy, 'admin');
  assert.equal((await admin.call('POST', '/api/mpesa/reverse', { id, why: 'again' })).status, 409);
  assert.equal((await req(c1, [{ pid: 'v1', amt: 3000 }])).status, 200);                                       // back in Unmatched
  const pos = await c1.call('POST', '/api/mpesa/request', { target: { type: 'pos', id: 'TRN-1', label: 'POS' }, allocs: [{ pid: 'p4', amt: 500 }], evidence: EV }); assert.equal(pos.status, 200);
  await admin2.call('POST', '/api/mpesa/decide', { id: pos.body.record.id, action: 'approve' });
  const rp = await admin.call('POST', '/api/mpesa/reverse', { id: pos.body.record.id, why: 'test' }); assert.equal(rp.status, 400); assert.match(rp.body.error, /Credit Note/);
});
test('other screens see the request; audit has no phone numbers or evidence; licence lock', async () => {
  const w = new Client(); await w.login('boss2', 'Staff#Pass-2026!'); const base = (await w.call('GET', '/api/state')).body.rev, c1 = await mkUser('cash10', 'Cashier');
  assert.ok((await sync(c1, [credit('s1', 'SEE1', 800)])).body.results[0].ok);
  const r = await req(c1, [{ pid: 's1', amt: 800 }]);
  const ch = (await w.call('GET', '/api/changes?since=' + base)).body.changes; assert.ok(ch.some(x => x.c === 'mps' && x.id === r.body.record.id));
  const au = JSON.stringify((await admin.call('GET', '/api/admin/audit?limit=500')).body.rows); for (const k of ['mpesa_settlement_requested', 'mpesa_settlement_approved', 'mpesa_settlement_rejected', 'mpesa_settlement_reversed']) assert.ok(au.includes(k), k);
  assert.ok(!au.includes('SMS: Confirmed') && !au.includes('JOHN DOE'));
  const L = (await state(dev))['obj:lic'].records[0]; await sync(dev, [up1(dev, 'obj:lic', 'main', { ...L.data, status: 'Active', expiry: '2020-01-01', grace: 0 }, L.ver)]);
  assert.equal((await req(c1, [{ pid: 's1', amt: 1 }])).status, 402);
  assert.equal((await admin2.call('POST', '/api/mpesa/decide', { id: r.body.record.id, action: 'approve' })).status, 402);
});
