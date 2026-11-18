// ECBS HotelSuite - Cloudflare edition.
//   Worker  : receives every request, serves the web page, and forwards API calls to the tenant's Durable Object.
//   Tenant  : one Durable Object per hotel (tenant); its built-in SQLite database holds that hotel's data, and its
//             alarm runs the nightly room billing (replaces the setInterval timer of the Node version).
import { timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const cjs = m => (m && m.default) || m;
let appP = null;
// The CommonJS server code is loaded on the first request, after the Worker's variables/secrets have been copied
// into process.env (the code reads its settings from there, exactly as on Node).
function loadApp(env) {
  if (!appP) {
    for (const [k, v] of Object.entries(env || {})) if (typeof v === 'string') process.env[k] = v;
    appP = Promise.all([import('../src/server.js'), import('./sql-adapter.js')]).then(([s, a]) => ({ ...cjs(s), createAdapter: cjs(a).createAdapter }));
  }
  return appP;
}
const TENANT_RE = /^[a-z0-9_-]{1,40}$/;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const tenantOf = (app, url) => {
  const t = url.pathname.startsWith('/_ops/') && url.searchParams.get('tenant') ? String(url.searchParams.get('tenant')).toLowerCase() : app.tenantForHost(url.host);
  return TENANT_RE.test(t) ? t : 'default';
};

export default {
  async fetch(request, env) {
    const app = await loadApp(env), url = new URL(request.url), p = url.pathname;
    if (request.method === 'GET' && (p === '/' || p === '/index.html')) {                   // the web page (static asset) + the same security headers as the Node server
      const r = await env.ASSETS.fetch(new Request(url.origin + '/'));
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...app.SEC_HEADERS } });
    }
    if (p === '/favicon.ico') return new Response(null, { status: 204, headers: app.SEC_HEADERS });
    if (!p.startsWith('/api/') && p !== '/healthz' && !p.startsWith('/_ops/')) return json(404, { error: 'Not found' }, app.SEC_HEADERS);
    const stub = env.TENANT.get(env.TENANT.idFromName(tenantOf(app, url)));
    return stub.fetch(request);
  }
};

export class Tenant {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.tid = null;
    this.booted = ctx.blockConcurrencyWhile(() => this.boot());
  }
  async boot() {
    const app = this.app = await loadApp(this.env);
    app.db.useAdapters(AsyncLocalStorage);                                 // each Durable Object's own database follows its requests
    this.adapter = app.createAdapter(this.ctx.storage.sql);
    await app.db.runWith(this.adapter, async () => {
      if (process.env.MIGRATE !== 'false') await app.db.migrate();
      await this.adapter.enableUndo();
    });
  }
  async fetch(request) {
    await this.booted;
    const app = this.app, url = new URL(request.url), tid = tenantOf(app, url);
    return app.db.runWith(this.adapter, async () => {
      if (this.tid !== tid) {                                              // first request of this tenant since the object started
        await app.ensureTenant(tid);
        if (tid === (process.env.TENANT_ID || 'default')) await app.bootstrap(tid);   // first administrator, from the ADMIN_* secrets
        this.tid = tid;
        await this.schedule(false);
      }
      return url.pathname.startsWith('/_ops/') ? this.ops(request, url, tid) : this.serve(request, url);
    });
  }
  // Runs the existing request handler (src/server.js) against small stand-ins for Node's req / res.
  async serve(request, url) {
    const app = this.app, headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    headers.host = url.host;
    const cl = +headers['content-length'] || 0;
    if (cl > (+process.env.IMPORT_MAX_MB || 60) * 1048576 + 1048576) return json(413, { error: 'Request too large' }, app.SEC_HEADERS);
    const m = request.method, body = m === 'GET' || m === 'HEAD' || m === 'DELETE' ? undefined : await request.text();
    const req = { method: m, url: url.pathname + url.search, headers, socket: { remoteAddress: headers['cf-connecting-ip'] || '' }, _body: body };
    const out = { status: 200, headers: {}, body: null, headersSent: false };
    const res = {
      get headersSent() { return out.headersSent; },
      setHeader(k, v) { out.headers[k] = v; },
      writeHead(s, h) { out.status = s; Object.assign(out.headers, h || {}); out.headersSent = true; },
      end(b) { out.body = b == null || b === '' ? null : b; }
    };
    await app.run(req, res);
    return new Response(out.status === 204 || out.status === 304 ? null : out.body, { status: out.status, headers: out.headers });
  }
  // Operator endpoint, e.g. to create the first user of an additional hotel:
  //   POST /_ops/user?tenant=hotelb   Authorization: Bearer <OPS_TOKEN>   {"username":"boss","role":"Admin"}
  async ops(request, url, tid) {
    const tok = process.env.OPS_TOKEN || '';
    if (tok.length < 16) return json(404, { error: 'Not found' });
    const got = Buffer.from(request.headers.get('authorization') || ''), want = Buffer.from('Bearer ' + tok);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return json(401, { error: 'Unauthorized' });
    if (request.method !== 'POST' || url.pathname !== '/_ops/user') return json(404, { error: 'Not found' });
    let b; try { b = await request.json(); } catch (e) { return json(400, { error: 'Invalid JSON' }); }
    try { return json(200, await this.app.provisionUser(tid, b.username, b.role, { reset: !!b.reset, password: b.password })); }
    catch (e) { return json(e.status || 500, { error: e.message }); }
  }
  async schedule(force) {
    if (process.env.BILLING_TIMER === 'off') return;
    if (force || (await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + (+process.env.BILLING_TICK_SEC || 60) * 1000);
  }
  // Every minute: the same check the Node timer did ("is it billing time yet? post any missing nights").
  async alarm() {
    await this.booted;
    try { await this.app.db.runWith(this.adapter, () => this.app.billing.tick()); }
    catch (e) { console.log(JSON.stringify({ level: 'error', msg: 'billing alarm failed', err: e.message })); }
    await this.schedule(true);
  }
}
