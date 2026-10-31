'use strict';
// Nightly room billing, done by the SERVER (so it happens at the billing time even when nobody is signed in).
// This is a faithful port of the browser's runPost/postTo/postRoom/adjRate (public/index.html); a test compares the two.
const crypto = require('crypto'), db = require('./db');
const pad = n => String(n).padStart(2, '0');
const localDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const addD = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const r2 = n => Math.round(n * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const uid = () => 's' + Date.now().toString(36) + crypto.randomInt(0, 999);

module.exports = function billing({ audit, licenseBlocked, log, gate }) {
  const done = new Map();
  async function rec(t, tid, coll) {
    const r = (await t.q("SELECT data,ver FROM records WHERE tenant_id=? AND coll=? AND rid='main' AND deleted=0", [tid, coll]))[0];
    return r ? { d: JSON.parse(r.data), ver: r.ver } : null;
  }
  const clock = () => { const n = new Date(); return { hm: pad(n.getHours()) + ':' + pad(n.getMinutes()), date: localDate(n) }; };
  async function keyFor(tid) {
    const rm = await rec(db, tid, 'obj:rm'), cfg = await rec(db, tid, 'obj:cfg'), c = clock();
    const post = (rm && rm.d.post) || '05:30', t0 = (cfg && cfg.d.bizDate) || c.date;
    return t0 + ':' + (c.hm >= post ? 'after' : 'before');
  }
  // Posts every missing night up to (billing-date - 1) for each in-house reservation. Safe to repeat: it never posts a night twice.
  async function run(tid, o = {}) {
    const manual = !!o.manual, by = o.by || 'system', out = { n: 0, reservations: 0, upTo: null, skipped: '' };
    if (gate && !(await gate(tid))) { out.skipped = 'room billing is not part of this package'; return out; }
    const res = await db.tx(async t => {
      await t.q('UPDATE tenants SET rev=rev WHERE id=?', [tid]);                       // take the tenant lock (same as every other write)
      if (await licenseBlocked(t, tid)) { out.skipped = 'licence inactive'; return out; }
      const rm = await rec(t, tid, 'obj:rm'), cfg = await rec(t, tid, 'obj:cfg'), c = clock();
      const post = (rm && rm.d.post) || '05:30', t0 = (cfg && cfg.d.bizDate) || c.date;
      const Rd = c.hm >= post ? t0 : addD(t0, -1), upTo = addD(Rd, -1); out.upTo = upTo;
      const typeOf = {}; (await t.q("SELECT data FROM records WHERE tenant_id=? AND coll='rooms' AND deleted=0", [tid])).forEach(r => { const d = JSON.parse(r.data); typeOf[d.no] = d.type; });
      const rpr = (await t.q("SELECT data FROM records WHERE tenant_id=? AND coll='rpr' AND deleted=0 ORDER BY seq", [tid])).map(r => JSON.parse(r.data));   // rules apply in the order they were entered, exactly as on screen
      const adjRate = (r, d) => {
        if (r.nopr) return r.rate;
        let a = r.rate;
        rpr.filter(p => (p.cat === 'All' || p.cat === typeOf[r.room]) && d >= p.from && d <= p.to).forEach(p => { a = p.kind === '%' ? a * (1 + p.val / 100) : a + (+p.val || 0); });
        return Math.max(0, r2(a));
      };
      const rows = await t.q("SELECT rid,data,ver FROM records WHERE tenant_id=? AND coll='resv' AND deleted=0 ORDER BY seq", [tid]), changes = [], at = new Date().toLocaleString();
      for (const row of rows) {
        const r = JSON.parse(row.data);
        if (r.st !== 'In-House' || !DATE_RE.test(r.in || '') || typeof r.rate !== 'number') continue;
        if (!Array.isArray(r.fl)) r.fl = []; if (!Array.isArray(r.posted)) r.posted = [];
        let n = 0;
        for (let d = r.in, k = 0; d <= upTo && k < 400; d = addD(d, 1), k++) {
          if (r.posted.includes(d)) continue;
          r.fl.push({ id: uid(), date: d, type: 'Room', desc: 'Room bill for ' + d + ' – Rm ' + r.room, amt: adjRate(r, d), by: 'Auto ' + post, auto: true, at, ts: Date.now() });
          r.posted.push(d); n++;
        }
        if (n) { changes.push({ row, r, n }); out.n += n; }
      }
      out.reservations = changes.length;
      const total = changes.length + ((out.n || manual) && rm ? 1 : 0);
      if (!total) return out;
      let rev = Number((await t.q('UPDATE tenants SET rev=rev+? WHERE id=? RETURNING rev', [total, tid]))[0].rev) - total, ts = Date.now();
      for (const { row, r } of changes) {
        const data = JSON.stringify(r); rev++;
        await t.q("UPDATE records SET data=?, ver=ver+1, rev=?, updated_by='system', updated_at=? WHERE tenant_id=? AND coll='resv' AND rid=?", [data, rev, ts, tid, row.rid]);
        if (process.env.HISTORY !== 'off') await t.q("INSERT INTO history(tenant_id,coll,rid,ver,op,data,by_user,ts) VALUES(?,'resv',?,?,?,?,?,?)", [tid, row.rid, row.ver + 1, 'update', data, 'system', ts]);
      }
      if ((out.n || manual) && rm) {
        const nd = { ...rm.d, last: { at, n: out.n } }; rev++;
        await t.q("UPDATE records SET data=?, ver=ver+1, rev=?, updated_by='system', updated_at=? WHERE tenant_id=? AND coll='obj:rm' AND rid='main'", [JSON.stringify(nd), rev, ts, tid]);
      }
      return out;
    });
    if (res.n || manual) await audit(tid, by, 'room_billing', res.n + ' room bill(s) posted up to ' + res.upTo + (manual ? ' (run by hand)' : ' (automatic)'), o.ip);
    return res;
  }
  // Called every minute: runs once after the billing time each day, and once as a catch-up before it (same rhythm as the old browser rule).
  async function tick() {
    for (const { id } of await db.q('SELECT id FROM tenants')) {
      try {
        const k = await keyFor(id);
        if (done.get(id) === k) continue;
        const r = await run(id);
        done.set(id, k);
        if (r.n) log({ msg: 'room billing', tenant: id, posted: r.n, upTo: r.upTo });
      } catch (e) { log({ level: 'error', msg: 'room billing failed', tenant: id, err: e.message }); }
    }
  }
  let timer = null;
  const start = () => { if (process.env.BILLING_TIMER === 'off' || timer) return; setTimeout(tick, 4000).unref(); timer = setInterval(tick, 60000); timer.unref(); };
  return { run, tick, start, keyFor, _done: done };
};
