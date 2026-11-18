'use strict';
// Runs the WHOLE existing test-suite against the Cloudflare code path, without Cloudflare:
//   Node http  ->  Fetch Request  ->  cf/worker.mjs (Worker)  ->  Tenant Durable Object  ->  sql-adapter  ->  node:sqlite
// ECBS_TARGET=cf npm test      (all Durable Objects share one in-memory SQLite here, so tests can look at the data directly)
const http = require('http'), fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
let server, mock;
const state = { alarm: null, objects: new Map(), env: null, worker: null };
function mockSql() {                                  // same shape as Durable Object ctx.storage.sql
  const db = new DatabaseSync(':memory:');
  return { raw: db, exec(q, ...b) { const st = db.prepare(q); return { toArray: () => st.all(...b) }; } };
}
async function start() {
  const worker = await import('../cf/worker.mjs');
  mock = mockSql();
  const objects = state.objects; state.worker = worker;
  const env = {
    ASSETS: { fetch: async () => new Response(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html')), { headers: { 'content-type': 'text/html' } }) },
    TENANT: {
      idFromName: n => n,
      get: n => {
        if (!objects.has(n)) {
          const ctx = { storage: { sql: mock, getAlarm: async () => state.alarm, setAlarm: async t => { state.alarm = t; } }, blockConcurrencyWhile: fn => fn() };
          objects.set(n, new worker.Tenant(ctx, env));
        }
        return objects.get(n);
      }
    }
  };
  state.env = env;
  server = http.createServer((req, res) => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', async () => {
      try {
        const h = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (!['host', 'content-length', 'connection', 'transfer-encoding'].includes(k)) h.set(k, v);
        const body = c.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(c) : undefined;
        const r = await worker.default.fetch(new Request('http://' + (req.headers.host || 'localhost') + req.url, { method: req.method, headers: h, body }), env);
        const out = {}; r.headers.forEach((v, k) => { out[k] = v; });
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (sc.length) out['set-cookie'] = sc;
        res.writeHead(r.status, out); res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { console.error('bridge error', e); res.writeHead(500); res.end(String(e && e.stack)); }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}
module.exports = { start, mockSql, state, get mock() { return mock; } };
