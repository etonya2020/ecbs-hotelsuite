'use strict';
// Post-deployment check against a LIVE server (works for PostgreSQL deployments too):
//   BASE_URL=https://hotel.example.com SMOKE_USER=admin SMOKE_PASSWORD='your password' node scripts/smoke.js
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''), U = process.env.SMOKE_USER, P = process.env.SMOKE_PASSWORD;
let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : '  -> ' + x)); if (!c) bad++; };
(async () => {
  const h = await fetch(BASE + '/healthz'); ok('health check (database reachable)', h.ok);
  const i = await fetch(BASE + '/'); const hd = i.headers;
  ok('security headers (CSP, frame, nosniff)', hd.get('content-security-policy') && hd.get('x-frame-options') === 'DENY' && hd.get('x-content-type-options') === 'nosniff');
  ok('HSTS present (HTTPS deployments)', BASE.startsWith('http://') ? true : !!hd.get('strict-transport-security'));
  ok('API refuses anonymous access', (await fetch(BASE + '/api/state')).status === 401);
  if (!U || !P) { console.log('(set SMOKE_USER and SMOKE_PASSWORD to test sign-in and data writes)'); process.exit(bad ? 1 : 0); }
  const l = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: U, password: P }) });
  const lj = await l.json().catch(() => ({})); ok('sign in', l.ok, lj.error);
  if (!l.ok) process.exit(1);
  const sc = l.headers.get('set-cookie') || ''; ok('session cookie is HttpOnly + SameSite=Strict', /HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc)); if (BASE.startsWith('https')) ok('session cookie is Secure', /Secure/i.test(sc));
  const cookie = sc.split(';')[0], H = { 'Content-Type': 'application/json', cookie, 'X-CSRF-Token': lj.csrf };
  ok('password already changed from the temporary one', !lj.user.must_change);
  const s = await fetch(BASE + '/api/state', { headers: { cookie } }); ok('read data', s.ok);
  const id = 'smoke-' + Date.now();
  const w = await (await fetch(BASE + '/api/sync', { method: 'POST', headers: H, body: JSON.stringify({ ops: [{ c: 'smoke', id, ver: null, data: { t: Date.now() } }] }) })).json().catch(() => ({}));
  ok('write to database', w.results && w.results[0] && w.results[0].ok, JSON.stringify(w));
  const d = await (await fetch(BASE + '/api/sync', { method: 'POST', headers: H, body: JSON.stringify({ ops: [{ c: 'smoke', id, ver: 1, del: true }] }) })).json().catch(() => ({})); ok('delete from database', d.results && d.results[0] && d.results[0].ok);
  const n1 = await (await fetch(BASE + '/api/numbers/next', { method: 'POST', headers: H, body: JSON.stringify({ prefix: 'SMK' }) })).json(), n2 = await (await fetch(BASE + '/api/numbers/next', { method: 'POST', headers: H, body: JSON.stringify({ prefix: 'SMK' }) })).json(); ok('document numbers increase', n2.n === n1.n + 1);
  const bad2 = await fetch(BASE + '/api/sync', { method: 'POST', headers: { ...H, 'X-CSRF-Token': 'wrong' }, body: '{"ops":[]}' }); ok('CSRF protection active', bad2.status === 403);
  await fetch(BASE + '/api/logout', { method: 'POST', headers: H }); ok('sign out', (await fetch(BASE + '/api/me', { headers: { cookie } })).status === 401);
  console.log(bad ? '\n' + bad + ' check(s) FAILED' : '\nAll checks passed'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('Smoke test error:', e.message); process.exit(1); });
