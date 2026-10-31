'use strict';
const db = require('../src/db');
db.migrate().then(() => { console.log('Database schema is up to date (' + db.kind + ')'); return db.close(); }).catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
