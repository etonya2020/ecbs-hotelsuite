'use strict';
// Time in the HOTEL's time zone (TZ, default Africa/Nairobi). Cloudflare Workers always run in UTC and ignore TZ,
// so the nightly-billing clock must not use Date#getHours()/getDate(); this works the same on Node and on Workers.
const cache = new Map();
const zone = () => process.env.TZ || 'Africa/Nairobi';
function fmt(tz) {
  let f = cache.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (e) { f = fmt('Africa/Nairobi'); }
    cache.set(tz, f);
  }
  return f;
}
function parts(d = new Date(), tz = zone()) {
  const o = {};
  for (const p of fmt(tz).formatToParts(d)) o[p.type] = p.value;
  const hh = o.hour === '24' ? '00' : o.hour;
  return { date: `${o.year}-${o.month}-${o.day}`, hm: `${hh}:${o.minute}`, hms: `${hh}:${o.minute}:${o.second}` };
}
module.exports = { zone, parts, stamp: () => new Date().toLocaleString(undefined, { timeZone: zone() }) };
