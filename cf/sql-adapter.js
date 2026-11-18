'use strict';
// Turns a Durable Object's SQLite (ctx.storage.sql) into the {q, exec, tx, close} interface the rest of the server uses.
//
// Durable Object SQLite refuses BEGIN / SAVEPOINT and only offers a *synchronous* transactionSync(), but this server's
// transactions are async functions. So tx() serialises work (like the Node SQLite adapter does) and keeps an UNDO JOURNAL:
// triggers record the inverse of every change while a transaction runs, and a failed (or interrupted) transaction is rolled
// back by replaying that journal in reverse. If journal triggers cannot be created the server still runs, without rollback
// (a warning is logged).
const adapters = new WeakMap();
const quoteId = s => '"' + String(s).replace(/"/g, '""') + '"';
const split = text => String(text).split(/;\s*(?:\r?\n|$)/).map(x => x.trim()).filter(Boolean);

function createAdapter(sql, { undo = true, log = o => console.log(JSON.stringify(o)) } = {}) {
  if (adapters.has(sql)) return adapters.get(sql);
  const clean = p => p.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  const run = (q, p = []) => sql.exec(q, ...clean(p)).toArray().map(r => ({ ...r }));
  let lock = Promise.resolve();                       // one logical connection: serialise everything
  const exclusive = fn => { const r = lock.then(fn, fn); lock = r.catch(() => {}); return r; };
  let journal = false;

  function setupJournal() {
    run('CREATE TABLE IF NOT EXISTS ecbs_undo(id INTEGER PRIMARY KEY AUTOINCREMENT, stmt TEXT NOT NULL)');
    run('CREATE TABLE IF NOT EXISTS ecbs_undo_on(active INTEGER NOT NULL, sig TEXT NOT NULL DEFAULT \'\')');
    if (!run('SELECT 1 AS x FROM ecbs_undo_on').length) run('INSERT INTO ecbs_undo_on(active,sig) VALUES(0,\'\')');
    const tables = run("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7)<>'sqlite_' AND substr(name,1,9)<>'ecbs_undo' AND substr(name,1,1)<>'_' ORDER BY name");
    const spec = tables.map(t => ({ t: t.name, cols: run('SELECT name FROM pragma_table_info(' + "'" + t.name.replace(/'/g, "''") + "'" + ')').map(c => c.name) }));
    const sig = JSON.stringify(spec);
    if (run('SELECT sig FROM ecbs_undo_on')[0].sig !== sig) {                      // (re)build the triggers only when the tables changed
      for (const r of run("SELECT name FROM sqlite_master WHERE type='trigger' AND substr(name,1,10)='ecbs_undo_'")) run('DROP TRIGGER ' + quoteId(r.name));
      for (const { t, cols } of spec) {
        const T = quoteId(t), cl = cols.map(quoteId).join(','), old = cols.map(c => 'quote(OLD.' + quoteId(c) + ')').join("||','||");
        const when = 'WHEN (SELECT active FROM ecbs_undo_on)=1';
        const restore = "'INSERT OR REPLACE INTO " + T.replace(/'/g, "''") + "(rowid," + cl.replace(/'/g, "''") + ") VALUES('||OLD.rowid||','||" + old + "||')'";
        run('CREATE TRIGGER ' + quoteId('ecbs_undo_i_' + t) + ' AFTER INSERT ON ' + T + ' ' + when + " BEGIN INSERT INTO ecbs_undo(stmt) VALUES('DELETE FROM " + T.replace(/'/g, "''") + " WHERE rowid='||NEW.rowid); END");
        run('CREATE TRIGGER ' + quoteId('ecbs_undo_u_' + t) + ' AFTER UPDATE ON ' + T + ' ' + when + ' BEGIN INSERT INTO ecbs_undo(stmt) VALUES(' + restore + '); END');
        run('CREATE TRIGGER ' + quoteId('ecbs_undo_d_' + t) + ' AFTER DELETE ON ' + T + ' ' + when + ' BEGIN INSERT INTO ecbs_undo(stmt) VALUES(' + restore + '); END');
      }
      run('UPDATE ecbs_undo_on SET sig=?', [sig]);
    }
    journal = true;
    if (run('SELECT active FROM ecbs_undo_on')[0].active === 1) { rollback(); log({ level: 'warn', msg: 'rolled back a transaction that was interrupted' }); }
  }
  function rollback() {
    run('UPDATE ecbs_undo_on SET active=0');
    for (const r of run('SELECT stmt FROM ecbs_undo ORDER BY id DESC')) run(r.stmt);
    run('DELETE FROM ecbs_undo');
  }

  const a = {
    kind: 'cf-sqlite',
    q: (s, p) => exclusive(() => run(s, p)),
    exec: text => exclusive(() => { for (const s of split(text)) run(s); }),
    tx: fn => exclusive(async () => {
      if (journal) { run('DELETE FROM ecbs_undo'); run('UPDATE ecbs_undo_on SET active=1'); }
      try {
        const out = await fn({ q: async (s, p) => run(s, p) });
        if (journal) { run('UPDATE ecbs_undo_on SET active=0'); run('DELETE FROM ecbs_undo'); }
        return out;
      } catch (e) {
        if (journal) { try { rollback(); } catch (e2) { log({ level: 'error', msg: 'rollback failed', err: e2.message }); } }
        throw e;
      }
    }),
    async close() {},
    // Call after the schema exists (db.migrate()): installs the undo-journal triggers.
    async enableUndo() {
      if (!undo || journal) return journal;
      try { setupJournal(); } catch (e) { journal = false; log({ level: 'warn', msg: 'transaction undo journal unavailable - writes will not roll back on error', err: e.message }); }
      return journal;
    },
    get journalOn() { return journal; }
  };
  adapters.set(sql, a);
  return a;
}
module.exports = { createAdapter };
