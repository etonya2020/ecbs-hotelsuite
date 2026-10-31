# Security notes – ECBS HotelSuite Server Edition

## Controls in place
| Area | What is done |
|---|---|
| Passwords | Hashed with scrypt (per-user salt). Minimum 10 characters, two character kinds, common passwords refused. No default passwords: the first administrator comes from `.env` (or a random one-time password in the log) and **must be changed at first login**. Reset passwords are random and single-use. |
| Sign-in | Same error for wrong user / wrong password, constant-time check, account locks 15 min after 5 failures (per account), generous per-IP limit (so one shared router does not lock out staff), every failure audited. |
| Sessions | Random 256-bit token in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie (`__Host-` prefix); only a hash is stored; 30 min idle / 12 h absolute; role change, disable, reset or password change signs the person out everywhere; admins can sign out sessions. Background refresh does not keep a session alive. |
| CSRF / cross-site | Per-session CSRF token on every change, `Origin` check, strict CSP (`frame-ancestors 'none'`), `X-Frame-Options`, `nosniff`, `no-referrer`, HSTS over HTTPS. |
| Permissions | Enforced **on the server** per role and per data collection (src/roles.js): licence & fee plans developer-only; payment-gateway, period-closing, tax, roles, etc. admin-only; audit trail append-only; payroll salaries hidden from roles without HR access; unknown roles can read but not write. Developers can tune roles at `PUT /api/admin/roles`. The browser menus are only convenience. |
| Licence | Created and checked by the server; customers cannot extend or reset it; expired/deactivated = read-only for everyone except the developer. |
| Data integrity | Versioned records, conflict detection, atomic document numbers (no duplicate invoice/receipt numbers across computers), idempotent retries, per-record change history. |
| Secrets | SMS / M-Pesa gateway keys encrypted at rest (AES-256-GCM, `DATA_KEY`) and **never sent to any browser, administrators included** (screens show `********`; saving with `********` keeps the stored key). Excluded from File → Backup exports. |
| Gateway relay | SMS and STK are sent by the server. Only roles that may send (SMS: front office, managers, admins; STK: cashiers, front office, accountants, managers, admins). https only and public addresses only – loopback, private, link-local, carrier-grade NAT, multicast and IPv4-in-IPv6 forms are refused, re-checked at connection time (DNS-rebinding safe); no redirects followed; 15 s timeout; response size capped; amount ≤ 250,000; limits per person per minute; audit records counts and amounts, never phone numbers or message text. |
| Clock-in PINs | 6–8 digits, no repeats or sequences, salted scrypt hashes held in a separate server-only table (never in the data screens read); 5 wrong tries lock the employee for 15 minutes; only HR / administrators set or unlock; every set, failure, lock and unlock is audited. Hashes from the old version are moved out of the data and upgraded on first use. |
| M-Pesa settlement | Requests, approvals and reversals go through server endpoints that check, inside one locked transaction, that every payment still has enough money available (amount − approved − pending − withdrawn), that internal / matched credits cannot be used, that evidence is given, and that the approver is an administrator and not the requester (developer excepted). Settlement and withdrawal records can only be written by administrators; credits can be added by cashiers but not edited or deleted (append-only) and a second credit with the same M-Pesa reference is refused. Audit entries hold request numbers and amounts, never phone numbers or evidence text. |
| Room billing | Runs on the server under a database lock, never posts a night twice, skips automatically when the licence has lapsed, and is recorded in the audit trail as "system". |
| Input | Parameterised SQL only, JSON size limits, collection/ID whitelists, prototype-pollution keys rejected. |
| Audit | Logins, failures, password changes, user changes, denied writes, deletions, imports/exports, role changes – File → Security & Audit Log. |
| Database | Runs as a non-root container; PostgreSQL is not exposed to the internet in the provided compose file; nightly backups (optionally encrypted). |
| Multi-site | `TENANT_MAP` gives each resort separate users, data, numbering and licence; sessions cannot cross sites. |

## Known limits (be honest with customers)
* Receipt entries for an approved M-Pesa settlement are written by the approving administrator's screen (with automatic completion by the next administrator screen if it closed early); a determined administrator could still alter them, which the audit trail and record history would show.
* Clock-in PINs are for attendance, not for security: a signed-in user whose role may write attendance can still add attendance records directly (audited).
* The gateway must accept the simple JSON the system sends; the key is sent to it as a bearer token over https.
* In-memory API rate limiting is per server instance (login lockouts are in the database and work across instances).
* No two-factor sign-in yet; no IP allow-listing (use your cloud firewall / VPN for the admin screens if needed).
* A user with write access to a collection can change any record in it – the audit trail and history show who and when.

## Go-live checklist
1. HTTPS working (padlock), `COOKIE_SECURE=true`, `scripts/smoke.js` all PASS.
2. Strong `ADMIN_PASSWORD`, `DB_PASSWORD`, `DATA_KEY` in `.env`; `.env` not shared or committed; copy of `DATA_KEY` stored safely.
3. Administrator and developer passwords changed from the temporary ones.
4. One account per person; remove the shared logins; give roles by job.
5. Firewall: only 80/443 open to the world; database private.
6. Backups running, copied off the server, and **one restore tested**.
7. Leave `CSP_CONNECT` empty (the browser needs no gateway access); only set `RELAY_ALLOW_PRIVATE` if your gateway really is on your own network.
8. Apply operating-system and Docker image updates monthly.
