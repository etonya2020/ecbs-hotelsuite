'use strict';
// Server-side permissions. The browser menus are only a convenience; THIS is what is enforced.
// write: collections a role may change ('*' = all except the protected sets below).
const DEV = 'Developer Super Admin', ADMIN = 'Admin';
const DEV_ONLY = new Set(['obj:lic', 'plans']);                           // licence record + fee plans: developer only
const ADMIN_ONLY = new Set(['mps', 'mpw', 'roles', 'obj:closed', 'obj:pay', 'obj:smsc', 'obj:adv', 'obj:hr', 'obj:tax', 'obj:asstcfg', 'agroups', 'alevels', 'keepers', 'pm', 'acdev', 'biodev']);
const APPEND_ONLY = new Set(['audit', 'smv', 'mpu']);                            // others may add, never edit or delete
const SECRETS = { 'obj:smsc': ['key'], 'obj:pay': ['gw.key'] };           // encrypted at rest, hidden from non-admins
const COMMON = ['audit', 'pcs', 'att', 'requests', 'pts', 'obj:rm', 'obj:meta', 'pcr'];      // every signed-in user (clock-in, requisitions, audit trail, nightly room-billing stamp)
const POS = ['mpu', 'sales', 'trn', 'pays', 'customers', 'items', 'smv', 'layers', 'batches', 'stk', 'vch', 'ccn', 'ginv', 'oinc'];
const FRONT = ['rooms', 'resv', 'guests', 'rrates', 'rpr', 'rcons', 'members', 'spabook', 'tickets', 'tpk', 'tbk', 'pickups', 'excursions', 'asst', 'lostfound', 'maint', 'acmd', 'sms', 'smst', 'staffmeals', 'functions', 'obj:ev'];
const STORES = ['items', 'stores', 'transfers', 'stockadj', 'grn', 'sissue', 'sret', 'preq', 'squo', 'lpo', 'counts', 'swo', 'smv', 'layers', 'batches', 'staffmeals', 'sph', 'debitnotes', 'cnotes', 'atr', 'averify', 'wo', 'msch', 'assets', 'capex', 'suppliers', 'obj:fa', 'obj:inv'];
const FINANCE = ['coa', 'journals', 'ajr', 'accounts', 'druns', 'assets', 'atr', 'averify', 'capex', 'expenses', 'purchases', 'paysupp', 'banking', 'debitnotes', 'cnotes', 'bdebt', 'oinc', 'ginv', 'ccn', 'pays', 'lpo', 'suppliers', 'sph', 'customers', 'sales', 'trn', 'acats', 'depts', 'obj:fa', 'obj:inv', 'gj', 'openbal', 'ccs', 'budgets', 'spq', 'mpu', 'mpw'];
const HR = ['staff', 'attend', 'leave', 'lv', 'att', 'bimp', 'shifts', 'depts'];
const DEFAULTS = {
  [DEV]: { write: ['*'], hr: true },
  [ADMIN]: { write: ['*'], hr: true },
  Manager: { write: ['*'], hr: true },
  Accountant: { write: [...COMMON, ...FINANCE, ...HR.filter(x => x !== 'staff')], hr: true },
  Cashier: { write: [...COMMON, ...POS, 'resv', 'guests', 'rooms', 'tbk', 'tickets', 'functions'], hr: false },
  'Front Office': { write: [...COMMON, ...POS, ...FRONT], hr: false },
  Housekeeping: { write: [...COMMON, 'rooms', 'maint', 'lostfound', 'rcons', 'items', 'smv', 'layers', 'batches', 'wo'], hr: false },
  'Store Keeper': { write: [...COMMON, ...STORES, 'customers'], hr: false }
};
const isAdminRole = r => r === DEV || r === ADMIN;
function canWrite(role, roles, coll, { del, exists }) {
  const r = roles[role];
  if (!r) return { ok: false, err: 'forbidden' };
  if (DEV_ONLY.has(coll)) return { ok: role === DEV, err: 'forbidden' };
  if (ADMIN_ONLY.has(coll)) return { ok: isAdminRole(role), err: 'forbidden' };
  if (APPEND_ONLY.has(coll) && exists && !isAdminRole(role)) return { ok: false, err: 'forbidden' };
  return { ok: r.write.includes('*') || r.write.includes(coll), err: 'forbidden' };
}
module.exports = { DEV, ADMIN, DEFAULTS, DEV_ONLY, ADMIN_ONLY, APPEND_ONLY, SECRETS, isAdminRole, canWrite };
