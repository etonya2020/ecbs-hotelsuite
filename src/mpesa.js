'use strict';
// Unmatched M-Pesa settlement rules, enforced on the SERVER so two cashiers on two computers can never use the same money twice.
// Everything below runs inside one database transaction that holds the tenant lock (same lock every other write uses).
const db = require('./db'), sec = require('./security'), R = require('./roles');
const r2 = n => Math.round(n * 100) / 100, pad = n => String(n).padStart(2, '0');
class Err extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const stamp = () => { const d = new Date(); return { date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), time: pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) }; };
async function load(t, tid, coll) { return (await t.q('SELECT rid,data,ver FROM records WHERE tenant_id=? AND coll=? AND deleted=0 ORDER BY seq', [tid, coll])).map(r => ({ rid: r.rid, ver: r.ver, d: JSON.parse(r.data) })); }
// available = amount − approved − pending − withdrawn
function avail(p, mps, mpw) {
  let used = 0, held = 0;
  for (const r of mps) for (const a of r.d.allocs || []) if (a.pid === p.d.id) { if (r.d.st === 'Approved') used += a.amt; else if (r.d.st === 'Pending') held += a.amt; }
  return r2(p.d.amt - used - held - mpw.filter(w => w.d.pid === p.d.id).reduce((s, w) => s + w.d.amt, 0));
}
module.exports = function ({ licenseBlocked }) {
  async function start(t, tid, user) {
    await t.q('UPDATE tenants SET rev=rev WHERE id=?', [tid]);
    if (user.role !== R.DEV && await licenseBlocked(t, tid)) throw new Err(402, 'The licence is inactive – the system is read-only');
  }
  async function save(t, tid, user, rec, data) {
    const rev = Number((await t.q('UPDATE tenants SET rev=rev+1 WHERE id=? RETURNING rev', [tid]))[0].rev), ts = Date.now();
    await t.q('UPDATE records SET data=?, ver=ver+1, rev=?, updated_by=?, updated_at=? WHERE tenant_id=? AND coll=? AND rid=?', [JSON.stringify(data), rev, user.name, ts, tid, 'mps', rec.rid]);
    if (process.env.HISTORY !== 'off') await t.q('INSERT INTO history(tenant_id,coll,rid,ver,op,data,by_user,ts) VALUES(?,?,?,?,?,?,?,?)', [tid, 'mps', rec.rid, rec.ver + 1, 'update', JSON.stringify(data), user.name, ts]);
    return { id: rec.rid, ver: rec.ver + 1, data };
  }
  async function request(tid, user, body) {
    const ev = String(body.evidence || '').trim(), tg = body.target || {}, al = Array.isArray(body.allocs) ? body.allocs : [];
    if (ev.length < 10) throw new Err(400, 'Evidence is mandatory – give the name the guest paid under, the SMS text or the statement line');
    if (!['folio', 'invoice', 'pos', 'customer'].includes(tg.type) || typeof tg.id !== 'string' || !tg.id || tg.id.length > 160) throw new Err(400, 'Choose the bill to settle');
    if (!al.length || al.length > 20) throw new Err(400, 'Select between 1 and 20 payments');
    return db.tx(async t => {
      await start(t, tid, user);
      const mpu = await load(t, tid, 'mpu'), mps = await load(t, tid, 'mps'), mpw = await load(t, tid, 'mpw'), seen = new Set(), out = []; let total = 0;
      for (const a of al) {
        const pid = String(a.pid || ''), amt = r2(+a.amt);
        if (seen.has(pid)) throw new Err(400, 'The same payment is listed twice'); seen.add(pid);
        const p = mpu.find(x => x.d.id === pid || x.rid === pid); if (!p) throw new Err(404, 'A selected payment no longer exists');
        if (p.d.tag !== 'Customer') throw new Err(400, 'Payment ' + p.d.ref + ' is tagged ' + p.d.tag + ' and cannot be used');
        if (!(amt > 0)) throw new Err(400, 'Enter an amount for each selected payment');
        const av = avail(p, mps, mpw);
        if (amt > av + 0.004) throw new Err(409, 'Payment ' + p.d.ref + ' has only ' + av.toFixed(2) + ' available – another request may be holding the rest');
        out.push({ pid: p.d.id, ref: p.d.ref, name: p.d.name || '', amt }); total = r2(total + amt);
      }
      const n = Number((await t.q("INSERT INTO sequences(tenant_id,prefix,n) VALUES(?,'MPS',1) ON CONFLICT(tenant_id,prefix) DO UPDATE SET n=sequences.n+1 RETURNING n", [tid]))[0].n);
      const rev = Number((await t.q('UPDATE tenants SET rev=rev+1 WHERE id=? RETURNING rev', [tid]))[0].rev), rid = sec.uuid(), ts = Date.now(), s = stamp();
      const data = { id: rid, _id: rid, no: 'MPS-' + String(n).padStart(5, '0'), date: s.date, time: s.time, st: 'Pending', target: { type: tg.type, id: tg.id, label: String(tg.label || '').slice(0, 200), cust: String(tg.cust || '').slice(0, 120) }, allocs: out, amt: total, evidence: ev.slice(0, 600), by: user.name, pc: String(body.pc || '').slice(0, 60) };
      await t.q('INSERT INTO records(tenant_id,coll,rid,kind,seq,data,ver,deleted,rev,updated_by,updated_at) VALUES(?,?,?,?,?,?,1,0,?,?,?)', [tid, 'mps', rid, 'arr', rev, JSON.stringify(data), rev, user.name, ts]);
      if (process.env.HISTORY !== 'off') await t.q('INSERT INTO history(tenant_id,coll,rid,ver,op,data,by_user,ts) VALUES(?,?,?,?,?,?,?,?)', [tid, 'mps', rid, 1, 'insert', JSON.stringify(data), user.name, ts]);
      return { record: { id: rid, ver: 1, data } };
    });
  }
  async function decide(tid, user, body) {
    const act = body.action, why = String(body.why || '').trim();
    if (!['approve', 'reject'].includes(act)) throw new Err(400, 'Unknown action');
    if (!R.isAdminRole(user.role)) throw new Err(403, 'Administrators only');
    return db.tx(async t => {
      await start(t, tid, user);
      const mps = await load(t, tid, 'mps'), rec = mps.find(x => x.rid === String(body.id || '')); if (!rec) throw new Err(404, 'Request not found');
      if (rec.d.st !== 'Pending') throw new Err(409, 'Request is not pending (it is ' + rec.d.st + ')');
      if (rec.d.by === user.name && user.role !== R.DEV) throw new Err(403, 'A different administrator must approve – you requested this settlement');
      if (act === 'reject' && !why) throw new Err(400, 'Enter the reason for rejecting');
      if (act === 'approve') {
        const mpu = await load(t, tid, 'mpu'), mpw = await load(t, tid, 'mpw');
        for (const a of rec.d.allocs) { const p = mpu.find(x => x.d.id === a.pid); if (!p || p.d.tag !== 'Customer') throw new Err(409, 'Payment ' + a.ref + ' is no longer available'); if (avail(p, mps, mpw) < -0.004) throw new Err(409, 'Payment ' + a.ref + ' no longer has enough available balance'); }
      }
      const s = stamp(), d = { ...rec.d, st: act === 'approve' ? 'Approved' : 'Rejected', appr: user.name, apprAt: s.date + ' ' + s.time }; if (why) d.why = why.slice(0, 300);
      return { record: await save(t, tid, user, rec, d) };
    });
  }
  async function reverse(tid, user, body) {
    const why = String(body.why || '').trim();
    if (!R.isAdminRole(user.role)) throw new Err(403, 'Administrators only');
    if (!why) throw new Err(400, 'Enter the reason');
    return db.tx(async t => {
      await start(t, tid, user);
      const mps = await load(t, tid, 'mps'), rec = mps.find(x => x.rid === String(body.id || '')); if (!rec) throw new Err(404, 'Request not found');
      if (rec.d.st !== 'Approved') throw new Err(409, 'Only approved settlements can be reversed');
      if (rec.d.target.type === 'pos') throw new Err(400, 'A POS sale is undone with a Customer Credit Note, not here');
      const s = stamp();
      return { record: await save(t, tid, user, rec, { ...rec.d, st: 'Reversed', revBy: user.name, revAt: s.date + ' ' + s.time, revWhy: why.slice(0, 300), unposted: false }) };
    });
  }
  return { request, decide, reverse, Err };
};
