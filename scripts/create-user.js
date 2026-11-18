'use strict';
// Emergency / command-line account tool. Needs shell access to the server, so it replaces the old "recovery key".
//   node scripts/create-user.js <username> <role> [--reset]
//   e.g.  node scripts/create-user.js admin Admin --reset      (new temporary password for a locked-out administrator)
const db = require('../src/db'), sec = require('../src/security');
(async () => {
  const [u, role] = process.argv.slice(2).filter(a => !a.startsWith('--')), reset = process.argv.includes('--reset');
  const tid = process.env.TENANT_ID || 'default';
  if (!u || !role) { console.log('Usage: node scripts/create-user.js <username> <role> [--reset]'); process.exit(1); }
  await db.migrate();
  const username = u.toLowerCase(), pw = sec.randomPassword(), hash = await sec.hashPw(pw);
  const ex = (await db.q('SELECT id FROM users WHERE tenant_id=? AND username=?', [tid, username]))[0];
  if (ex && !reset) { console.error('User exists. Add --reset to set a new temporary password.'); process.exit(1); }
  if (ex) { await db.q('UPDATE users SET pw_hash=?, must_change=1, active=1, role=? WHERE id=?', [hash, role, ex.id]); await db.q('DELETE FROM sessions WHERE user_id=?', [ex.id]); await db.q('DELETE FROM login_attempts WHERE k=?', ['u:' + tid + ':' + username]); }
  else await db.q('INSERT INTO users(id,tenant_id,username,display,role,pw_hash,active,must_change,created_at) VALUES(?,?,?,?,?,?,1,1,?)', [sec.uuid(), tid, username, username, role, hash, Date.now()]);
  await db.q('INSERT INTO audit_log(ts,tenant_id,user_name,action,detail,ip) VALUES(?,?,?,?,?,?)', [Date.now(), tid, 'cli', ex ? 'user_updated' : 'user_created', username + ' via command line', 'local']);
  console.log(`\n${ex ? 'Reset' : 'Created'} "${username}" (${role}). Temporary password: ${pw}\nIt must be changed at first login.\n`);
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
