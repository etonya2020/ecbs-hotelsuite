'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), crypto = require('node:crypto');
const { up, down, Client, db, sync, up1, app } = require('./helpers');
const NEW = 'Better#Pass-9981';
let admin, dev, gw, calls = [], gwUrl;
const pad = n => String(n).padStart(2, '0');
const ld = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const addD = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const T = ld(new Date());
const legacy = p => crypto.createHash('sha256').update('edbis:' + p).digest('hex');
async function mkUser(name, role) {
  const r = (await admin.call('POST', '/api/admin/users', { username: name, role, display: name })).body, c = new Client();
  await c.login(name, r.temp_password); await c.call('POST', '/api/change-password', { old: r.temp_password, new: 'Staff#Pass-2026!' }); return c;
}
const state = async c => (await c.call('GET', '/api/state')).body.collections;
test.before(async () => {
  await up();
  admin = new Client(); await admin.login('admin', 'Adm1n!Start-2026'); await admin.call('POST', '/api/change-password', { old: 'Adm1n!Start-2026', new: NEW });
  dev = new Client(); await dev.login('edbis', 'Dev!Start-2026-xx'); await dev.call('POST', '/api/change-password', { old: 'Dev!Start-2026-xx', new: 'Dev#Changed-77aa' });
  gw = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      let j = {}; try { j = JSON.parse(b); } catch (e) {} calls.push({ url: req.url, auth: req.headers.authorization, body: j });
      if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); return res.end(); }
      if (j.to === '254700000500') { res.writeHead(500); return res.end('boom'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise(r => gw.listen(0, '127.0.0.1', r)); gwUrl = 'http://127.0.0.1:' + gw.address().port;
});
test.after(async () => { gw.close(); await down(); });

/* ---------------- PIN ---------------- */
test('clock-in PINs: hashes stay on the server, legacy hashes are upgraded, weak PINs refused', async () => {
  const w = (await sync(admin, [up1(admin, 'staff', 'st1', { id: 'e1', name: 'Jane', salary: 50000, pinh: legacy('4321') })])).body.results[0]; assert.ok(w.ok);
  const raw = (await db.q("SELECT data FROM records WHERE coll='staff'"))[0].data; assert.ok(!raw.includes('pinh') && !raw.includes(legacy('4321')));
  assert.equal((await db.q("SELECT legacy FROM staff_pins WHERE staff_id='e1'"))[0].legacy, 1);
  const seen = (await state(admin)).staff.records[0].data; assert.equal(seen.pinh, 'set'); assert.ok(!JSON.stringify(await state(admin)).includes(legacy('4321')));
  const cash = await mkUser('cash1', 'Cashier'), mgr = await mkUser('mgr1', 'Manager');
  let v = await cash.call('POST', '/api/pin/verify', { staff: 'e1', pin: '4321' }); assert.equal(v.status, 200); assert.equal(v.body.weak, true);
  assert.equal((await db.q("SELECT legacy,pin_hash FROM staff_pins WHERE staff_id='e1'"))[0].legacy, 0);
  assert.match((await db.q("SELECT pin_hash FROM staff_pins WHERE staff_id='e1'"))[0].pin_hash, /^scrypt\$/);
  assert.equal((await cash.call('POST', '/api/pin/verify', { staff: 'e1', pin: '4321' })).status, 200);               // still works after the upgrade
  assert.equal((await cash.call('POST', '/api/pin/set', { staff: 'e1', pin: '482915' })).status, 403);               // only HR / admins set PINs
  for (const bad of ['123456', '654321', '111111', '12ab56', '4829', '123456789', '121212']) assert.equal((await mgr.call('POST', '/api/pin/set', { staff: 'e1', pin: bad })).status, 400, bad);
  assert.equal((await mgr.call('POST', '/api/pin/set', { staff: 'nobody', pin: '482915' })).status, 404);
  assert.equal((await mgr.call('POST', '/api/pin/set', { staff: 'e1', pin: '482915' })).status, 200);
  v = await cash.call('POST', '/api/pin/verify', { staff: 'e1', pin: '482915' }); assert.equal(v.status, 200); assert.equal(v.body.weak, false);
  assert.equal((await cash.call('POST', '/api/pin/verify', { staff: 'e1', pin: '4321' })).status, 403);
  // editing the employee from the screen (which only knows pinh:'set') must not erase or replace the PIN
  const rec = (await state(admin)).staff.records[0];
  assert.ok((await sync(admin, [up1(admin, 'staff', 'st1', { ...rec.data, name: 'Jane W', pinh: 'set' }, rec.ver)])).body.results[0].ok);
  assert.equal((await cash.call('POST', '/api/pin/verify', { staff: 'e1', pin: '482915' })).status, 200);
  assert.equal((await cash.call('POST', '/api/pin/verify', { staff: 'e1', pin: 'x'.repeat(2000) })).status, 403);
});
test('PIN lockout after 5 wrong tries; HR can unlock; setting a new PIN also unlocks', async () => {
  const c = await mkUser('cash2', 'Cashier'), hr = admin;
  await hr.call('POST', '/api/pin/unlock', { staff: 'e1' });                  // start from a clean count
  const left = [];
  for (let i = 0; i < 4; i++) { const r = await c.call('POST', '/api/pin/verify', { staff: 'e1', pin: '000' + i + '99' }); assert.equal(r.status, 403); left.push(r.body.error); }
  assert.match(left[0], /4 attempts left/); assert.match(left[3], /1 attempt left/);
  const lock = await c.call('POST', '/api/pin/verify', { staff: 'e1', pin: '000099' }); assert.equal(lock.status, 403); assert.match(lock.body.error, /locked/);
  const during = await c.call('POST', '/api/pin/verify', { staff: 'e1', pin: '482915' }); assert.equal(during.status, 429);          // even the right PIN is refused while locked
  assert.equal((await c.call('POST', '/api/pin/unlock', { staff: 'e1' })).status, 403);
  assert.equal((await hr.call('POST', '/api/pin/unlock', { staff: 'e1' })).status, 200);
  assert.equal((await c.call('POST', '/api/pin/verify', { staff: 'e1', pin: '482915' })).status, 200);
  for (let i = 0; i < 5; i++) await c.call('POST', '/api/pin/verify', { staff: 'e1', pin: '999990' });
  assert.equal((await c.call('POST', '/api/pin/verify', { staff: 'e1', pin: '482915' })).status, 429);
  assert.equal((await hr.call('POST', '/api/pin/set', { staff: 'e1', pin: '713524' })).status, 200);
  assert.equal((await c.call('POST', '/api/pin/verify', { staff: 'e1', pin: '713524' })).status, 200);
  assert.equal((await c.call('POST', '/api/pin/verify', { staff: 'ghost', pin: '713524' })).status, 404);
  const acts = (await admin.call('GET', '/api/admin/audit?limit=500')).body.rows; const set = new Set(acts.map(a => a.action));
  for (const k of ['pin_set', 'pin_failed', 'pin_locked', 'pin_unlocked']) assert.ok(set.has(k), k);
  assert.ok(!JSON.stringify(acts).includes('713524') && !JSON.stringify(acts).includes('482915'));
});
test('PIN rows follow employee deletion and imports', async () => {
  const imp = (await admin.call('POST', '/api/admin/import', { state: { staff: [{ id: 'e9', name: 'Imported', pinh: legacy('7777') }] }, replace: false })).body; assert.equal(imp.records, 1);
  assert.equal((await db.q("SELECT legacy FROM staff_pins WHERE staff_id='e9'"))[0].legacy, 1);
  assert.ok(!(await db.q("SELECT data FROM records WHERE coll='staff'")).some(r => r.data.includes('pinh')));
  const cash = await mkUser('cash3', 'Cashier'); assert.equal((await cash.call('POST', '/api/pin/verify', { staff: 'e9', pin: '7777' })).status, 200);
  const st = (await state(admin)).staff.records.find(r => r.data.id === 'e9');
  assert.ok((await sync(admin, [{ c: 'staff', id: st.id, ver: st.ver, del: true }])).body.results[0].ok);
  assert.equal((await db.q("SELECT 1 AS x FROM staff_pins WHERE staff_id='e9'")).length, 0);
  assert.equal((await cash.call('POST', '/api/pin/verify', { staff: 'e9', pin: '7777' })).status, 404);
});

/* ---------------- relay ---------------- */
test('SMS relay: server sends with the stored key; browsers never see it', async () => {
  const fo = await mkUser('fo1', 'Front Office'), cash = await mkUser('cash4', 'Cashier'), hk = await mkUser('hk1', 'Housekeeping');
  assert.equal((await fo.call('POST', '/api/relay/sms', { messages: [{ to: '254711111111', message: 'Hi' }] })).body.error, 'SMS gateway is not set up');
  const w = (await sync(admin, [up1(admin, 'obj:smsc', 'main', { on: true, url: gwUrl + '/sms', key: 'GW-KEY', sender: 'SAIWA', user: 'saiwa' })])).body.results[0]; assert.ok(w.ok);
  const raw = (await db.q("SELECT data FROM records WHERE coll='obj:smsc'"))[0].data; assert.ok(!raw.includes('GW-KEY') && raw.includes('enc:'));
  for (const c of [admin, fo, cash, hk]) assert.equal((await state(c))['obj:smsc'].records[0].data.key, '********');
  calls.length = 0;
  const r = await fo.call('POST', '/api/relay/sms', { messages: [{ to: '254711111111', message: 'Welcome to Saiwa' }, { to: '254700000500', message: 'x' }, { to: 'abc', message: 'x' }, { to: '254722222222', message: '' }] });
  assert.equal(r.status, 200); assert.deepEqual(r.body.results.map(x => x.ok), [true, false, false, false]);
  assert.equal(r.body.results[1].err, 'HTTP 500'); assert.equal(r.body.results[2].err, 'Invalid number');
  const c1 = calls.find(c => c.body.to === '254711111111'); assert.equal(c1.auth, 'Bearer GW-KEY'); assert.equal(c1.body.from, 'SAIWA'); assert.equal(c1.body.username, 'saiwa'); assert.equal(c1.url, '/sms');
  assert.equal((await cash.call('POST', '/api/relay/sms', { messages: [{ to: '254711111111', message: 'x' }] })).status, 403);
  assert.equal((await hk.call('POST', '/api/relay/sms', { messages: [{ to: '254711111111', message: 'x' }] })).status, 403);
  assert.equal((await fo.call('POST', '/api/relay/sms', { messages: [] })).status, 400);
  assert.equal((await fo.call('POST', '/api/relay/sms', { messages: new Array(101).fill({ to: '254711111111', message: 'x' }) })).status, 400);
  // re-saving the settings screen (key shown as ********) must keep the real key; a new key replaces it; an empty key removes it
  let rec = (await state(admin))['obj:smsc'].records[0];
  assert.ok((await sync(admin, [up1(admin, 'obj:smsc', 'main', { ...rec.data, sender: 'SAIWA2' }, rec.ver)])).body.results[0].ok);
  calls.length = 0; await fo.call('POST', '/api/relay/sms', { messages: [{ to: '254711111111', message: 'a' }] }); assert.equal(calls[0].auth, 'Bearer GW-KEY'); assert.equal(calls[0].body.from, 'SAIWA2');
  rec = (await state(admin))['obj:smsc'].records[0];
  await sync(admin, [up1(admin, 'obj:smsc', 'main', { ...rec.data, key: 'NEW-KEY' }, rec.ver)]);
  calls.length = 0; await fo.call('POST', '/api/relay/sms', { messages: [{ to: '254711111111', message: 'a' }] }); assert.equal(calls[0].auth, 'Bearer NEW-KEY');
  assert.ok(!(await db.q("SELECT data FROM records WHERE coll='obj:smsc'"))[0].data.includes('NEW-KEY'));
  rec = (await state(admin))['obj:smsc'].records[0];
  await sync(admin, [up1(admin, 'obj:smsc', 'main', { ...rec.data, key: '' }, rec.ver)]);
  calls.length = 0; await fo.call('POST', '/api/relay/sms', { messages: [{ to: '254711111111', message: 'a' }] }); assert.equal(calls[0].auth, undefined);
  const au = JSON.stringify((await admin.call('GET', '/api/admin/audit?limit=500')).body.rows); assert.ok(au.includes('sms_sent')); assert.ok(!au.includes('254711111111') && !au.includes('Welcome'));
});
test('STK relay', async () => {
  const cash = await mkUser('cash5', 'Cashier'), hk = await mkUser('hk2', 'Housekeeping');
  assert.equal((await cash.call('POST', '/api/relay/stk', { phone: '254711222333', amount: 1500, reference: 'INV-1' })).body.error, 'STK gateway is not set up');
  await sync(admin, [up1(admin, 'obj:pay', 'main', { till: '123', gw: { on: true, url: gwUrl + '/stk', key: 'STK-KEY' } })]);
  assert.equal((await state(cash))['obj:pay'].records[0].data.gw.key, '********');
  calls.length = 0; const r = await cash.call('POST', '/api/relay/stk', { phone: '254711222333', amount: 1500, reference: 'INV-1' });
  assert.deepEqual([r.status, r.body.ok], [200, true]); assert.deepEqual(calls[0].body, { phone: '254711222333', amount: 1500, reference: 'INV-1', description: 'Payment INV-1' }); assert.equal(calls[0].auth, 'Bearer STK-KEY'); assert.equal(calls[0].url, '/stk');
  for (const amount of [0, -5, 300000, 'abc']) assert.equal((await cash.call('POST', '/api/relay/stk', { phone: '254711222333', amount, reference: 'x' })).status, 400);
  assert.equal((await cash.call('POST', '/api/relay/stk', { phone: '12', amount: 100, reference: 'x' })).status, 400);
  assert.equal((await hk.call('POST', '/api/relay/stk', { phone: '254711222333', amount: 100, reference: 'x' })).status, 403);
  const rec = (await state(admin))['obj:pay'].records[0];
  await sync(admin, [up1(admin, 'obj:pay', 'main', { ...rec.data, gw: { ...rec.data.gw, url: gwUrl + '/redirect' } }, rec.ver)]);
  const rr = await cash.call('POST', '/api/relay/stk', { phone: '254711222333', amount: 100, reference: 'x' }); assert.equal(rr.body.ok, false); assert.match(rr.body.err, /redirected/);
  const au = JSON.stringify((await admin.call('GET', '/api/admin/audit?limit=500')).body.rows); assert.ok(au.includes('stk_sent') && au.includes('stk_failed')); assert.ok(!au.includes('254711222333'));
});
test('relay cannot be aimed at internal addresses (SSRF)', async () => {
  const fo = await mkUser('fo2', 'Front Office'), M = [{ to: '254711111111', message: 'x' }];
  const setUrl = async (url) => { const rec = (await state(admin))['obj:smsc'].records[0]; await sync(admin, [up1(admin, 'obj:smsc', 'main', { ...rec.data, on: true, url }, rec.ver)]); };
  const send = async () => (await fo.call('POST', '/api/relay/sms', { messages: M })).body.results[0];
  const keep = { p: process.env.RELAY_ALLOW_PRIVATE, h: process.env.RELAY_ALLOW_HTTP };
  try {
    process.env.RELAY_ALLOW_PRIVATE = 'false'; process.env.RELAY_ALLOW_HTTP = 'false'; calls.length = 0;
    for (const [url, msg] of [[gwUrl, /https/], ['http://169.254.169.254/latest/meta-data', /https/], ['file:///etc/passwd', /https/], ['ftp://x.example/', /https/], ['not a url', /not valid/], ['https://user:pw@example.com/', /password/],
      ['https://127.0.0.1/', /not allowed/], ['https://[::1]/', /not allowed/], ['https://10.0.0.5/x', /not allowed/], ['https://192.168.1.10/', /not allowed/], ['https://169.254.169.254/latest', /not allowed/], ['https://172.16.0.1/', /not allowed/], ['https://100.64.0.1/', /not allowed/], ['https://[::ffff:127.0.0.1]/', /not allowed/], ['https://localhost/', /not allowed/]]) {
      await setUrl(url); const r = await send(); assert.equal(r.ok, false, url); assert.match(r.err, msg, url);
    }
    assert.equal(calls.length, 0);                                          // nothing ever reached the local test gateway
    process.env.RELAY_ALLOW_HTTP = 'true'; await setUrl(gwUrl); const r2 = await send(); assert.equal(r2.ok, false); assert.match(r2.err, /not allowed/);   // http allowed but 127.0.0.1 still private
    assert.equal(calls.length, 0);
    process.env.RELAY_ALLOW_PRIVATE = 'true'; assert.equal((await send()).ok, true);                                                                           // explicit opt-in for an on-premises gateway
  } finally { process.env.RELAY_ALLOW_PRIVATE = keep.p; process.env.RELAY_ALLOW_HTTP = keep.h; }
  const { isPrivate } = require('../src/relay'); for (const ip of ['10.1.1.1', '127.0.0.1', '0.0.0.0', '224.0.0.1', 'fd00::1', 'fe80::1', '::1', '::ffff:7f00:1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '::127.0.0.1', 'fec0::1', 'garbage']) assert.ok(isPrivate(ip), ip); for (const ip of ['8.8.8.8', '41.90.1.1', '2606:4700::1111']) assert.ok(!isPrivate(ip), ip);
});
test('relay is rate limited per person', async () => {
  const fo = await mkUser('fo3', 'Front Office');
  const rec = (await state(admin))['obj:smsc'].records[0]; await sync(admin, [up1(admin, 'obj:smsc', 'main', { ...rec.data, url: gwUrl + '/sms' }, rec.ver)]);
  let last; for (let i = 0; i < 31; i++) last = await fo.call('POST', '/api/relay/sms', { messages: [{ to: '254711111111', message: 'x' }] });
  assert.equal(last.status, 429);
});

/* ---------------- room billing timer ---------------- */
const entry = (r, d) => r.fl.find(e => e.date === d && e.type === 'Room');
test('server posts room charges: seasonal pricing, no double posting, partial catch-up', async () => {
  const W = [up1(admin, 'rooms', 'rm1', { no: '1', type: 'Std', rate: 5000 }), up1(admin, 'rooms', 'rm2', { no: '2', type: 'Deluxe', rate: 8000 }),
    up1(admin, 'rpr', 'zz', { cat: 'Std', kind: '%', val: 10, from: addD(T, -30), to: addD(T, 30) }), up1(admin, 'rpr', 'aa', { cat: 'All', kind: '+', val: 500, from: addD(T, -1), to: addD(T, -1) }),
    up1(admin, 'obj:rm', 'main', { post: '00:00', ci: '14:00', co: '10:00' }),
    up1(admin, 'resv', 'v1', { id: 'RES-1', guest: 'A', room: '1', in: addD(T, -3), out: addD(T, 2), st: 'In-House', rate: 5000, adults: 1, plan: 'BB', fl: [], posted: [] }),
    up1(admin, 'resv', 'v2', { id: 'RES-2', guest: 'B', room: '2', in: addD(T, -1), out: addD(T, 2), st: 'In-House', rate: 8000, nopr: true, adults: 1, plan: 'RO', fl: [], posted: [] }),
    up1(admin, 'resv', 'v3', { id: 'RES-3', guest: 'C', room: '1', in: addD(T, 5), out: addD(T, 7), st: 'Booked', rate: 5000, adults: 1, plan: 'RO', fl: [], posted: [] }),
    up1(admin, 'resv', 'v4', { id: 'RES-4', guest: 'D', room: '1', in: addD(T, -2), out: addD(T, 3), st: 'In-House', rate: 5000, adults: 1, plan: 'BB', fl: [{ id: 'old', date: addD(T, -2), type: 'Room', amt: 5500 }], posted: [addD(T, -2)] })];
  assert.ok((await sync(admin, W)).body.results.every(x => x.ok));
  const other = await mkUser('fo9', 'Front Office'); const base = (await other.call('GET', '/api/state')).body.rev;
  const r = await app.billing.run('default', { manual: true, by: 'tester' });
  assert.equal(r.n, 5); assert.equal(r.reservations, 3); assert.equal(r.upTo, addD(T, -1));
  const st = await state(admin), R = id => st.resv.records.find(x => x.data.id === id);
  const v1 = R('RES-1').data, v2 = R('RES-2').data, v3 = R('RES-3').data, v4 = R('RES-4').data;
  assert.deepEqual([entry(v1, addD(T, -3)).amt, entry(v1, addD(T, -2)).amt, entry(v1, addD(T, -1)).amt], [5500, 5500, 6000]);     // +10% season, then +500 on one day
  assert.equal(entry(v2, addD(T, -1)).amt, 8000);                                                                                // "no seasonal pricing" respected
  assert.equal(v3.fl.length, 0); assert.deepEqual(v4.posted, [addD(T, -2), addD(T, -1)]); assert.equal(v4.fl.length, 2);          // booked guest untouched; only the missing night added
  const e = entry(v1, addD(T, -1)); assert.equal(e.by, 'Auto 00:00'); assert.equal(e.auto, true); assert.equal(e.desc, 'Room bill for ' + addD(T, -1) + ' – Rm 1'); assert.ok(e.id && e.ts && e.at);
  assert.deepEqual(v1.posted, [addD(T, -3), addD(T, -2), addD(T, -1)]);
  assert.equal(R('RES-1').ver, 2); assert.equal(st['obj:rm'].records[0].data.last.n, 5); assert.equal(st['obj:rm'].records[0].data.post, '00:00');
  const ch = (await other.call('GET', '/api/changes?since=' + base)).body.changes.filter(c => c.c === 'resv'); assert.equal(ch.length, 3);   // other screens pick it up
  const again = await app.billing.run('default', { manual: true, by: 'tester' }); assert.equal(again.n, 0);
  assert.equal((await state(admin)).resv.records.find(x => x.data.id === 'RES-1').ver, 2);                                        // no new version when nothing to post
  const hist = await db.q("SELECT by_user FROM history WHERE coll='resv' AND rid='v1' AND op='update'"); assert.equal(hist[0].by_user, 'system');
  const au = (await admin.call('GET', '/api/admin/audit?limit=500&action=room_billing')).body.rows; assert.ok(au.length >= 1); assert.match(au[au.length - 1].detail, /posted up to/);
});
test('billing permissions, licence lock, business date and the timer', async () => {
  const fo = await mkUser('fo8', 'Front Office'), hk = await mkUser('hk8', 'Housekeeping');
  assert.equal((await hk.call('POST', '/api/billing/run', {})).status, 403);
  assert.equal((await fo.call('POST', '/api/billing/run', {})).status, 200);
  // the timer: runs once per phase of the day, picks up newly checked-in guests, then waits
  app.billing._done.clear(); await sync(admin, [up1(admin, 'resv', 'v5', { id: 'RES-5', guest: 'E', room: '1', in: addD(T, -1), out: addD(T, 3), st: 'In-House', rate: 5000, adults: 1, plan: 'RO', fl: [], posted: [] })]);
  await app.billing.tick(); let st = await state(admin); assert.equal(st.resv.records.find(x => x.data.id === 'RES-5').data.posted.length, 1);
  await sync(admin, [up1(admin, 'resv', 'v6', { id: 'RES-6', guest: 'F', room: '1', in: addD(T, -1), out: addD(T, 3), st: 'In-House', rate: 5000, adults: 1, plan: 'RO', fl: [], posted: [] })]);
  await app.billing.tick(); st = await state(admin); assert.equal(st.resv.records.find(x => x.data.id === 'RES-6').data.posted.length, 0);   // already ran in this phase
  app.billing._done.clear(); await app.billing.tick(); st = await state(admin); assert.equal(st.resv.records.find(x => x.data.id === 'RES-6').data.posted.length, 1);
  // licence lapsed -> no automatic posting for the customer either (read-only)
  const L = (await state(dev))['obj:lic'].records[0];
  await sync(dev, [up1(dev, 'obj:lic', 'main', { ...L.data, status: 'Active', expiry: '2020-01-01', grace: 0 }, L.ver)]);
  assert.equal((await fo.call('POST', '/api/billing/run', {})).status, 402); assert.equal((await app.billing.run('default')).skipped, 'licence inactive');
  const L2 = (await state(dev))['obj:lic'].records[0]; await sync(dev, [up1(dev, 'obj:lic', 'main', { ...L2.data, expiry: '2099-01-01' }, L2.ver)]);
  // business-date override (used when back-dating) is honoured
  await sync(admin, [up1(admin, 'obj:cfg', 'main', { name: 'X', bizDate: addD(T, 5) })]);
  const r = await app.billing.run('default', { manual: true }); assert.equal(r.upTo, addD(T, 4)); assert.ok(r.n >= 5);
  st = await state(admin); assert.ok(st.resv.records.find(x => x.data.id === 'RES-1').data.posted.includes(addD(T, 4)));
  assert.equal(await app.billing.keyFor('default'), addD(T, 5) + ':after');
});
test('timer settings: before the billing time only the older nights are caught up', async () => {
  const rec = (await state(admin))['obj:rm'].records[0], rcfg = (await state(admin))['obj:cfg'].records[0];
  await sync(admin, [up1(admin, 'obj:cfg', 'main', { ...rcfg.data, bizDate: '' }, rcfg.ver), up1(admin, 'obj:rm', 'main', { ...rec.data, post: '23:59' }, rec.ver),
    up1(admin, 'resv', 'v7', { id: 'RES-7', guest: 'G', room: '1', in: addD(T, -4), out: addD(T, 3), st: 'In-House', rate: 5000, adults: 1, plan: 'RO', fl: [], posted: [] })]);
  const nowHm = pad(new Date().getHours()) + ':' + pad(new Date().getMinutes());
  if (nowHm >= '23:59') return;                                           // (only meaningful when it is not yet 23:59)
  const r = await app.billing.run('default'); assert.equal(r.upTo, addD(T, -2));     // billing time not reached: nights up to two days ago only
  const v7 = (await state(admin)).resv.records.find(x => x.data.id === 'RES-7').data; assert.deepEqual(v7.posted, [addD(T, -4), addD(T, -3), addD(T, -2)]);
});
