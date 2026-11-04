'use strict';
const test = require('node:test'), assert = require('node:assert');
process.env.PLATFORM_OWNER_PASSWORD = 'First!Owner-Pass-2026';
const { up, down, Client } = require('./helpers');
const app = require('../src/server');

test('forgotten passwords can be reset from environment secrets', async t => {
  await up();
  const P = new Client('localhost'), D = new Client('localhost');
  await t.test('panel owner', async () => {
    assert.equal((await P.call('POST', '/api/platform/login', { username: 'ettylinks', password: 'First!Owner-Pass-2026' })).status, 200);
    process.env.PLATFORM_OWNER_PASSWORD = 'Second!Owner-Pass-2026'; process.env.PLATFORM_OWNER_RESET = 'true';
    await app.platformBootstrap(); delete process.env.PLATFORM_OWNER_RESET;
    const P2 = new Client('localhost');
    assert.equal((await P2.call('POST', '/api/platform/login', { username: 'ettylinks', password: 'First!Owner-Pass-2026' })).status, 401);
    const ok = await P2.call('POST', '/api/platform/login', { username: 'ettylinks', password: 'Second!Owner-Pass-2026' }); assert.equal(ok.status, 200); assert.equal(ok.body.user.must_change, true);
    assert.equal((await P.call('GET', '/api/platform/me')).status, 401);       // old session killed
  });
  await t.test('standalone site administrator', async () => {
    assert.equal((await D.login('admin', 'Adm1n!Start-2026')).status, 200);
    process.env.ADMIN_PASSWORD = 'Reset!Manager-Key-2026'; process.env.ADMIN_RESET = 'true';
    await app.bootstrap(); delete process.env.ADMIN_RESET;
    assert.equal((await new Client('localhost').login('admin', 'Adm1n!Start-2026')).status, 401);
    const r = await new Client('localhost').login('admin', 'Reset!Manager-Key-2026'); assert.equal(r.status, 200); assert.equal(r.body.user.must_change, true);
  });
  await down();
});
