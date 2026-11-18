"use strict";
// Database adapter: PostgreSQL (production, any cloud), SQLite (local / tests / very small sites)
// or, on Cloudflare, one SQLite database per Durable Object (see cf/sql-adapter.js).
// DATABASE_URL=postgres://user:pass@host:5432/dbname   or   sqlite:./data/ecbs.db
const { isCF } = require("./runtime");
const lazy = n => require(n);                       // loaded only when used, so the Cloudflare bundle never needs pg / node:sqlite
let impl;
if (isCF) {
  impl = { kind: "cf" };
} else {
  const fs = lazy("fs"), path = lazy("path");
  const url = process.env.DATABASE_URL || "sqlite:./data/ecbs.db";
  if (/^postgres(ql)?:/.test(url)) {
    const pg = lazy("pg"), { Pool } = pg;
    pg.types.setTypeParser(20, v => Number(v));        // BIGINT -> number (revisions, timestamps, counters)
    const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: process.env.DB_SSL_STRICT !== "false" } : undefined;
    const pool = new Pool({ connectionString: url, max: +process.env.DB_POOL || 10, ssl });
    const conv = s => { let i = 0; return s.replace(/\?/g, () => "$" + (++i)); };
    impl = {
      kind: "pg",
      async q(sql, p = []) { return (await pool.query(conv(sql), p)).rows; },
      async exec(sql) { await pool.query(sql); },
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const out = await fn({ q: async (s, p = []) => (await c.query(conv(s), p)).rows });
          await c.query("COMMIT"); return out;
        } catch (e) { try { await c.query("ROLLBACK"); } catch (_) {} throw e; } finally { c.release(); }
      },
      async close() { await pool.end(); }
    };
  } else {
    const { DatabaseSync } = lazy("node:sqlite");
    const file = url.replace(/^sqlite:/, "");
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const clean = p => p.map(v => (v === undefined ? null : typeof v === "boolean" ? +v : v));
    const run = (sql, p = []) => db.prepare(sql).all(...clean(p)).map(r => ({ ...r }));
    let lock = Promise.resolve();                       // one connection: serialise everything
    const exclusive = fn => { const r = lock.then(fn, fn); lock = r.catch(() => {}); return r; };
    impl = {
      kind: "sqlite",
      q: (sql, p) => exclusive(() => run(sql, p)),
      exec: sql => exclusive(() => db.exec(sql)),
      tx: fn => exclusive(async () => {
        db.exec("BEGIN IMMEDIATE");
        try { const out = await fn({ q: async (s, p) => run(s, p) }); db.exec("COMMIT"); return out; }
        catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
      }),
      async close() { db.close(); }
    };
  }
}
// Cloudflare: every Durable Object owns its own database. Several Durable Objects can share one isolate, so the
// "current" database travels with the request through AsyncLocalStorage instead of a module-level variable.
impl.useAdapters = ALS => {                                // ALS = AsyncLocalStorage class (the Worker imports it; Node tests omit it)
  if (impl.adaptersOn) return;
  const als = new (ALS || lazy("node:async_hooks").AsyncLocalStorage)();
  const cur = () => { const a = als.getStore() || impl._last; if (!a) throw new Error("No database in this context"); return a; };
  Object.assign(impl, {
    adaptersOn: true, kind: "cf",
    q: (s, p) => cur().q(s, p), exec: s => cur().exec(s), tx: fn => cur().tx(fn),
    close: async () => {},
    runWith: (adapter, fn) => { impl._last = adapter; return als.run(adapter, fn); }
  });
};
impl.migrate = async () => {
  if (impl.kind === "cf") return impl.exec(require("./schema-sqlite"));
  const f = lazy("path").join(__dirname, "..", "db", impl.kind === "pg" ? "schema.pg.sql" : "schema.sqlite.sql");
  await impl.exec(lazy("fs").readFileSync(f, "utf8"));
};
module.exports = impl;
