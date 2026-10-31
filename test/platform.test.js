'use strict';
const test = require('node:test'), assert = require('node:assert');
process.env.PLATFORM_OWNER_PASSWORD = 'Plat!Owner-2026-xx';
process.env.PLATFORM_DOMAIN = 'apps.test';
const { up, down, Client, sync, up1 } = require('./helpers');

test('developer platform', async t => {
  await up();
  const P = new Client('localhost');   // unmapped host = developer panel host
  await t.test('panel page + favicon are served', async () => {
    const pg = await P.call('GET', '/platform'); assert.equal(pg.status, 200); assert.match(pg.text, /favicon\.ico/);
    const ic = await P.call('GET', '/platform/favicon-32.png'); assert.equal(ic.status, 200); assert.equal(ic.headers['content-type'], 'image/png');
    assert.equal((await new Client('x.apps.test').call('GET', '/platform')).status, 404);        // never on a client's address
  });
  await t.test('platform sign-in is separate and protected', async () => {
    assert.equal((await P.call('GET', '/api/platform/clients')).status, 401);
    assert.equal((await P.call('POST', '/api/platform/login', { username: 'ettylinks', password: 'wrong' })).status, 401);
    const r = await P.call('POST', '/api/platform/login', { username: 'ettylinks', password: process.env.PLATFORM_OWNER_PASSWORD });
    assert.equal(r.status, 200); P.csrf = r.body.csrf; assert.ok(r.body.user.owner);
    assert.equal((await P.call('POST', '/api/platform/clients', {}, { nocsrf: true })).status, 403);   // CSRF
  });
  // first-login password change is required for the owner
  await t.test('must change password first', async () => {
    const r = await P.call('GET', '/api/platform/clients'); assert.equal(r.status, 403); assert.equal(r.body.code, 'password_change_required');
    const c = await P.call('POST', '/api/platform/change-password', { old: process.env.PLATFORM_OWNER_PASSWORD, new: 'New!Owner-Pass-2026' }); assert.equal(c.status, 200);
    assert.equal((await P.call('GET', '/api/platform/clients')).status, 200);
  });
  let pk;
  await t.test('seed packages exist and can be edited', async () => {
    const r = await P.call('GET', '/api/platform/packages'); assert.ok(r.body.packages.length >= 3);
    const mk = await P.call('POST', '/api/platform/packages', { name: 'Tiny', price: 1000, cycle: 'monthly', modules: ['sales'], max_users: 2, trial_days: 7 });
    assert.equal(mk.status, 201); pk = mk.body.id;
  });
  let a, b;
  await t.test('deploy two organisations', async () => {
    const r1 = await P.call('POST', '/api/platform/clients', { name: 'Alpha Hotel', package_id: pk, admin_user: 'boss' });
    assert.equal(r1.status, 201); assert.ok(r1.body.temp_password); assert.equal(r1.body.url, 'https://alpha-hotel.apps.test'); a = r1.body;
    const r2 = await P.call('POST', '/api/platform/clients', { name: 'Beta Lodge', package_id: 'resort-complete', admin_user: 'boss', admin_password: 'Beta!Start-2026-xx', hosts: ['lodge.beta.co.ke'] });
    assert.equal(r2.status, 201); b = r2.body;
    assert.equal((await P.call('POST', '/api/platform/clients', { name: 'Alpha Hotel', package_id: pk })).status, 409);
  });
  const A = new Client('alpha-hotel.apps.test'), B = new Client('lodge.beta.co.ke');
  await t.test('each client signs in only on its own address', async () => {
    assert.equal((await A.login('boss', a.temp_password)).status, 200);
    assert.equal((await new Client('beta.apps.test').call('GET', '/')).status, 404);              // unknown organisation address
    assert.equal((await new Client('nobody.apps.test').login('boss', 'x')).status, 404);
    assert.equal((await B.login('boss', 'Beta!Start-2026-xx')).status, 200);
    const cross = new Client('lodge.beta.co.ke'); assert.equal((await cross.login('boss', a.temp_password)).status, 401);
  });
  await t.test('package decides modules; the server refuses the rest', async () => {
    const me = await A.call('GET', '/api/me'); assert.equal(me.body.plan.name, 'Tiny'); assert.deepEqual(me.body.plan.modules, ['sales']);
    assert.ok(me.body.plan.groupsOff.includes('Roomings')); assert.ok(me.body.plan.blocked.includes('resv'));
    const pw = await A.call('POST', '/api/change-password', { old: a.temp_password, new: 'Alpha!Pass-2026-x' }); assert.equal(pw.status, 200);
    const ok = await sync(A, [up1(A, 'customers', 'c1', { name: 'Walk-in' })]); assert.equal(ok.body.results[0].ok, true);
    const no = await sync(A, [up1(A, 'resv', 'r1', { room: '1' }), up1(A, 'sales', 's1', { total: 5 })]);
    assert.equal(no.body.results[0].ok, false); assert.equal(no.body.results[0].err, 'module'); assert.equal(no.body.results[1].ok, true);
    assert.equal((await A.call('POST', '/api/relay/sms', { messages: [{ to: '1', text: 'x' }] })).status, 403);
    assert.equal((await A.call('POST', '/api/billing/run', {})).status, 403);
    const full = await B.call('GET', '/api/me'); assert.equal(full.body.plan.groupsOff.length, 0);
  });
  await t.test('user limit follows the package', async () => {
    await A.login('boss', 'Alpha!Pass-2026-x');
    { const r0 = await A.call('POST', '/api/admin/users', { username: 'user2', role: 'Cashier' }); assert.equal(r0.status, 201, JSON.stringify(r0.body)); }
    const r = await A.call('POST', '/api/admin/users', { username: 'user3', role: 'Cashier' }); assert.equal(r.status, 402); assert.equal(r.body.code, 'user_limit');
  });
  await t.test('upgrade takes effect straight away', async () => {
    const u = await P.call('PUT', '/api/platform/clients/' + a.id, { add_modules: ['rooms'], max_users: 5 }); assert.equal(u.status, 200); assert.ok(u.body.modules.includes('rooms'));
    const me = await A.call('GET', '/api/me'); assert.ok(me.body.plan.modules.includes('rooms')); assert.ok(!me.body.plan.groupsOff.includes('Roomings'));
    const ok = await sync(A, [up1(A, 'rooms', 'rm1', { no: '1', type: 'Std', rate: 100, status: 'Vacant' })]); assert.equal(ok.body.results[0].ok, true);
    assert.equal((await A.call('POST', '/api/admin/users', { username: 'user3', role: 'Cashier' })).status, 201);
  });
  await t.test('payments extend the licence and sync the client licence record', async () => {
    const before = (await P.call('GET', '/api/platform/clients/' + a.id)).body.paid_until;
    const pay = await P.call('POST', '/api/platform/clients/' + a.id + '/payment', { periods: 2, amount: 2000, method: 'M-Pesa', ref: 'QWE123' }); assert.equal(pay.status, 201);
    assert.ok(pay.body.paid_until > before);
    const d = (await P.call('GET', '/api/platform/clients/' + a.id)).body; assert.equal(d.status, 'active'); assert.equal(d.payments.length, 1);
    const st = await A.call('GET', '/api/state'); const lic = st.body.collections['obj:lic'].records[0].data;
    assert.equal(lic.plan, 'Tiny'); assert.equal(lic.expiry, pay.body.paid_until); assert.equal(lic.status, 'Active');
    assert.equal((await P.call('GET', '/api/platform/overview')).body.mrr > 0, true);
  });
  await t.test('suspend blocks sign-in and kills sessions; reactivate restores', async () => {
    assert.equal((await P.call('PUT', '/api/platform/clients/' + a.id, { status: 'suspended' })).status, 200);
    const r = await A.call('GET', '/api/me'); assert.equal(r.status, 403); assert.equal(r.body.code, 'suspended');
    assert.equal((await new Client('alpha-hotel.apps.test').login('boss', 'Alpha!Pass-2026-x')).status, 403);
    assert.equal((await P.call('PUT', '/api/platform/clients/' + a.id, { status: 'active' })).status, 200);
    assert.equal((await A.login('boss', 'Alpha!Pass-2026-x')).status, 200);
  });
  await t.test('reset client admin password', async () => {
    const r = await P.call('POST', '/api/platform/clients/' + a.id + '/reset-admin', {}); assert.equal(r.status, 200); assert.equal(r.body.username, 'boss');
    assert.equal((await new Client('alpha-hotel.apps.test').login('boss', 'Alpha!Pass-2026-x')).status, 401);
    assert.equal((await A.login('boss', r.body.temp_password)).status, 200);
    assert.equal((await A.call('POST', '/api/change-password', { old: r.body.temp_password, new: 'Alpha!Pass-2026-y' })).status, 200);
  });
  await t.test('package edit updates every client on it', async () => {
    const r = await P.call('PUT', '/api/platform/packages/' + pk, { modules: ['sales', 'rooms', 'hr'] }); assert.equal(r.body.affected, 1);
    const me = await A.call('GET', '/api/me'); assert.ok(me.body.plan.modules.includes('hr'));
    assert.equal((await P.call('DELETE', '/api/platform/packages/' + pk)).status, 409);       // in use
  });
  await t.test('support role is limited; owner list protected', async () => {
    const mk = await P.call('POST', '/api/platform/users', { username: 'helper', role: 'Platform Support' }); assert.equal(mk.status, 201);
    const S2 = new Client('localhost'); let r = await S2.call('POST', '/api/platform/login', { username: 'helper', password: mk.body.temp_password }); S2.csrf = r.body.csrf;
    await S2.call('POST', '/api/platform/change-password', { old: mk.body.temp_password, new: 'Support!Pass-2026-x' });
    assert.equal((await S2.call('GET', '/api/platform/clients')).status, 200);
    assert.equal((await S2.call('POST', '/api/platform/clients/' + a.id + '/payment', { amount: 1 })).status, 403);
    assert.equal((await S2.call('PUT', '/api/platform/clients/' + a.id, { status: 'suspended' })).status, 403);
    assert.equal((await S2.call('POST', '/api/platform/packages', { name: 'x' })).status, 403);
    assert.equal((await S2.call('GET', '/api/platform/users')).status, 403);
    // the last owner cannot be removed
    const owners = (await P.call('GET', '/api/platform/users')).body.users.filter(u => u.role === 'Platform Owner');
    assert.equal((await P.call('PUT', '/api/platform/users/' + owners[0].id, { active: false })).status, 400);
  });
  await t.test('client data is isolated', async () => {
    assert.equal((await B.call('POST', '/api/change-password', { old: 'Beta!Start-2026-xx', new: 'Beta!Final-2026-yy' })).status, 200);
    const sa = await A.call('GET', '/api/state'), sb = await B.call('GET', '/api/state');
    assert.ok(!(sb.body.collections.customers || { records: [] }).records.length);
    assert.ok(!JSON.stringify(sb.body).includes('Walk-in'));
    assert.ok(sa.body.collections.customers.records.length === 1);
    // a client session can never reach the developer panel
    assert.equal((await A.call('GET', '/api/platform/clients')).status, 404);
  });
  await down();
});
