'use strict';
const http = require('http');
Object.assign(process.env, { DATABASE_URL: 'sqlite::memory:', COOKIE_SECURE: 'false', SCRYPT_N: '1024', ADMIN_PASSWORD: 'Adm1n!Start-2026', DEV_USER: 'edbis', DEV_PASSWORD: 'Dev!Start-2026-xx', PORT: '0', HOST: '127.0.0.1', DATA_KEY: 'unit-test-key', TENANT_MAP: 'other.test=tenantb', LOGIN_MAX_FAILS: '5', IMPORT_MAX_MB: '5', BILLING_TIMER: 'off', RELAY_ALLOW_PRIVATE: 'true', RELAY_ALLOW_HTTP: 'true' });
const app = require('../src/server');
const db = require('../src/db');
let srv, port;
async function up() { srv = await app.start(); port = srv.address().port; }
async function down() { await new Promise(r => srv.close(r)); }
class Client {
  constructor(host) { this.host = host; this.cookie = ''; this.csrf = ''; }
  call(method, path, body, o = {}) {
    return new Promise((ok, bad) => {
      const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
      const h = { Host: this.host || 'localhost', ...(o.headers || {}) };
      if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
      if (this.cookie && !o.nocookie) h.Cookie = this.cookie;
      if (this.csrf && !o.nocsrf && method !== 'GET') h['X-CSRF-Token'] = o.csrf || this.csrf;
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, res => {
        const c = []; res.on('data', d => c.push(d));
        res.on('end', () => {
          const sc = res.headers['set-cookie']; if (sc && sc[0]) { const v = sc[0].split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
          const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch (e) {}
          ok({ status: res.statusCode, body: j, text: t, headers: res.headers });
        });
      });
      r.on('error', bad); if (data) r.write(data); r.end();
    });
  }
  async login(u, p) { const r = await this.call('POST', '/api/login', { username: u, password: p }); if (r.status === 200) this.csrf = r.body.csrf; return r; }
}
const sync = (c, ops) => c.call('POST', '/api/sync', { ops });
const up1 = (c, coll, id, data, ver) => ({ c: coll, id, ver: ver == null ? null : ver, data });
module.exports = { up, down, Client, db, sync, up1, app };
