# ECBS HotelSuite – Server Edition (v2.3.0)
Developed by ECBS – Ettylinks Comprehensive Business Solution, 2026 · ettylinks.dev@gmail.com · +254 786 317 916

Business data now lives in a **database on your server**, not in the browser. Staff open the system in any browser, sign in with their own account, and every computer sees the same live data.

```
Browser  ──HTTPS──▶  Caddy (automatic TLS)  ──▶  ECBS app (Node.js)  ──▶  PostgreSQL
 (login, screens)                                  sessions, roles, audit      (all business data, backed up nightly)
```

## 1. Fastest way: any Linux VM with Docker (AWS, Azure, Google Cloud, DigitalOcean, Hetzner, Safaricom/Liquid…)
1. Create a small VM (2 vCPU / 2 GB RAM is plenty for a resort). Install Docker.
2. Point your domain's DNS **A record** (e.g. `hotel.yourresort.com`) at the VM's public IP. Open ports 80 and 443.
3. Copy this folder to the VM, then:
   ```
   cp .env.example .env      # fill in DOMAIN, DB_PASSWORD, DATA_KEY, ADMIN_PASSWORD (and optionally DEV_USER/DEV_PASSWORD)
   docker compose up -d --build
   ```
4. Open `https://your-domain`, sign in as the administrator, and choose a new password when asked. The first sign-in uploads the starting setup into the database.
5. Check it: `BASE_URL=https://your-domain SMOKE_USER=admin SMOKE_PASSWORD='…' node scripts/smoke.js`

Try it on your own PC first (no domain, no HTTPS): `docker compose -f docker-compose.yml -f docker-compose.local.yml up --build db app` → http://localhost:3000. Without Docker: `npm install && npm start` uses a local SQLite file (`data/ecbs.db`) – fine for a demo or a single small site, not for production.

## 2. Using a managed database instead (recommended for production)
Run only the `app` container and point it at a managed PostgreSQL – AWS RDS, Azure Database for PostgreSQL, Google Cloud SQL, DigitalOcean/Aiven/Neon/Supabase (Supabase is just a Postgres host here), etc.
Set `DATABASE_URL=postgres://user:password@host:5432/dbname` and `DB_SSL=true`. The app creates its own tables on start. Keep the app and database in the same region. Turn on the provider's automatic backups and point-in-time recovery.

| Platform | How |
|---|---|
| AWS | EC2 or Lightsail + docker compose; or App Runner / ECS Fargate with the Dockerfile + RDS PostgreSQL |
| Azure | VM + compose; or Container Apps with the Dockerfile + Azure Database for PostgreSQL |
| Google Cloud | Cloud Run with the Dockerfile + Cloud SQL (set `TRUST_PROXY=true`) |
| Render / Railway / Fly.io | Deploy the Dockerfile, add their PostgreSQL, set the environment variables below |
Behind a platform that already provides HTTPS you do not need the `caddy` service. Always keep `COOKIE_SECURE=true` (the default) when users reach it over HTTPS, and `TRUST_PROXY=true` only when a trusted proxy sits in front.

## 3. Moving your existing browser data into the server
1. In the **old** (browser) version: File → Backup (Export) → download the file.
2. Sign in to the new server as administrator → File → **Restore (Import)** → choose that file.
3. Document numbers continue from where they were. Each old user gets a new account with a one-time temporary password (shown once – hand them out privately). Passwords from the old version cannot be copied (they were weak PIN hashes) – this is deliberate.
4. Check a few reports, then retire the old browser copy.

## 4. Daily operation
* **Users**: File → User Accounts (add, disable, reset password, unlock). **Sign-in history and audit trail**: File → Security & Audit Log. Everyone: File → Change My Password.
* **Locked out administrator** (forgot password): on the server run `docker compose exec app node scripts/create-user.js admin Admin --reset` – prints a new temporary password. This replaces the old "recovery key".
* **Backups**: the `backup` container writes a compressed (optionally encrypted) dump to `./backups` every 24 h and keeps 14 days. **Copy that folder off the server** (another cloud, another site). Test a restore once: `DATABASE_URL=postgres://… ./scripts/restore.sh backups/<file>.sql.gz` into an empty database. File → Backup (Export) also gives a portable copy at any time.
* **Updating**: copy the new files, `docker compose up -d --build`. The schema upgrades itself. Always back up first.
* **Nightly room billing** is done by the server at the time set under Room Billing Settings (default 05:30, in the time zone given by `TZ`), whether or not anyone is signed in. If the server was off, the missed nights are posted – dated correctly – as soon as it starts. Nothing is ever posted twice. "Run billing now" on the Room Billing Settings page runs the same job by hand. Each run is recorded in the audit trail.
* **SMS and M-Pesa STK pushes** are sent **by the server**. Enter the gateway address and key under File → SMS Setup / payment settings; the key is stored encrypted and the screens only ever show `********`. To change the key, type the new one; leave `********` to keep the current one. Gateway addresses must be `https://` and public. A gateway on your own network needs `RELAY_ALLOW_PRIVATE=true` (and `RELAY_ALLOW_HTTP=true` for plain http).
* **Clock-in PINs** are 6–8 digits, set by HR / administrators (Employees → Set PIN), stored only on the server as salted hashes, and checked by the server. 5 wrong tries lock that employee's PIN for 15 minutes; HR can **Unlock PIN** or set a new one. PINs from the old version keep working (the first successful clock-in upgrades them) – ask HR to replace short ones with 6-digit PINs.
* **Expenses & Accounts** (menu of the same name): Expenses (Simple) for money paid now, Expenses (Accruals) for a supplier bill to pay later, Petty Cash Requisitions (a different administrator approves, then cash is issued), Account Opening Balance, multi-line Journal Entries (must balance; foreign currency with a rate; a wrong one is reversed, never deleted), Add/Modify Expense Accounts, Departments, Cost Centres and Budget Entries; View Expenses / Opening Balances / Journal Entries (with date type, period picker, find, POS-printer option, Excel); reports 1 Account List, 2 Expense/Drawings, 3 Expense by Bank, 4 General Journal, 5 Budget vs Actual. Each bank / cash account can have its own ledger code (File of accounts: Banking & Cash → Bank Accounts) so balances are real.
* **Pay Bills** (Procurement): pick a supplier, tick the open bills (supplier invoices, accrued expenses, assets bought on credit), change "Amt. to pay" for part payments, then Pay Selected Bills: payment date, method, bank / cash account with its current balance, reference, documents, Print cheque requisition, Pay & New. **Withholding tax and withholding VAT** are kept back using the rates on the supplier record (Add/Modify Suppliers) and posted to 2110 / 2120. Cheques wait for a second administrator (Actions ▾); everything else posts at once. Payments can be reversed (the bill reopens). *Ask your accountant to confirm the withholding rates and the starter expense chart before go-live – they are defaults.*
* **Unmatched M-Pesa** (Sales → Customers & Payments): the register of M-Pesa credits that have not been matched to a bill. Add a credit by hand or **Import statement** (paste or upload the M-Pesa / bank CSV: Receipt/Ref, Date, Details, Paid in). Credits in the company's own name or bank-to-till sweeps are tagged **Internal** and never appear as customer money; a code already used on a receipt, folio or invoice is tagged **Matched**. **Settle from Unmatched M-Pesa**: 1) find the payment (ref, name, phone, voucher / note, date, amount – only the balance still available is shown), 2) choose the bill – a room folio, an invoice, a POS bill (settled in full) or a customer account (any extra stays as a credit), 3) give the evidence (mandatory). A **different administrator** approves under *M-Pesa Settlement Requests* (the developer account excepted); on approval the bill is credited, a receipt showing the M-Pesa reference prints, and the Unmatched M-Pesa liability (account 2250) is cleared. An administrator can **reverse** a wrong settlement (money returns to Unmatched, the bill reopens) and can **Refund / withdraw** from a payment. Available = amount − approved − pending − withdrawn, and **the server enforces it**: two cashiers on two computers cannot use the same money (one request wins, the other is refused). Every request, approval, rejection and reversal is in the audit trail.
* **Several windows at once (multitasking).** Every screen you open from the menu or the toolbar opens in **its own window** inside the system – a movable, resizable window with minimise, maximise and close – so you can have Purchases, Expenses and the POS open side by side on the same computer. All windows share **one live copy of the data**, one sign-in and one sync connection: a sale rung up in the POS window is instantly reflected in the Stock window, and an expense saved in one window shows in the others. Each window keeps its own screen state (two POS windows have two separate carts). How to use it: click a menu item or toolbar icon (a screen that is already open is brought to the front; **Ctrl+click** opens a second copy); the bar along the bottom lists the open windows (click to switch, click the active one to minimise) with **Tile**, **Cascade**, **Show desktop** and **Close all**; the **Window** menu has *Open a Screen in a New Window…* (type to search every screen) and a switch *Each Menu Click Opens Its Own Window: On / Off* (Off = the old single-window behaviour, Ctrl+click still opens a window). **Home / Close inside a window closes that window.** Up to 8 windows. Background windows refresh by themselves when other windows change the data, but a window you are working in – or one with half-typed entries – is never refreshed under you. On a phone each window opens full-screen.
* **Licence**: the 30-day trial is created by the server the first time it starts; only the developer account can record payments or change the licence. When it lapses the system becomes read-only for the customer.

## 5. Environment variables
| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `sqlite:./data/ecbs.db` | `postgres://user:pass@host:5432/db` for production |
| `DB_SSL` / `DB_SSL_STRICT` | off / true | TLS to a managed database |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / random (printed once in the log) | first administrator (must change at first login) |
| `DEV_USER` / `DEV_PASSWORD` | none | optional developer super-admin |
| `DATA_KEY` | none | encrypts SMS / M-Pesa gateway keys in the database – **set it and keep a copy** |
| `COOKIE_SECURE` | true | set `false` only for http on a private network |
| `TZ` | Africa/Nairobi | the hotel's time zone (billing time and "today" are read in it) |
| `BILLING_TIMER` | on | set `off` only if you want to post room charges by hand |
| `RELAY_ALLOW_PRIVATE` / `RELAY_ALLOW_HTTP` | false / false | allow an SMS/STK gateway on your own network / over plain http |
| `PIN_MAX_FAILS` | 5 | wrong PIN tries before a 15-minute lock |
| `TRUST_PROXY` | false | true behind Caddy / a load balancer (to see real client IPs) |
| `SESSION_IDLE_MIN` / `SESSION_MAX_HOURS` | 30 / 12 | automatic sign-out |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MIN` | 5 / 15 | account lock after repeated wrong passwords |
| `TENANT_MAP` | none | host→site map to serve several resorts from one server, e.g. `a.example.com=resorta,b.example.com=resortb` (each site has its own users, data and licence) |
| `CSP_CONNECT` | none | extra sites the browser itself may call. SMS / STK no longer need this (the server sends them) |
| `HISTORY` | on | keep a per-record change history (File → Security & Audit Log shows the audit trail; history is queryable at `/api/admin/history`) |
| `PORT`, `HOST`, `DB_POOL`, `BODY_MAX_MB`, `IMPORT_MAX_MB` | 3000, 0.0.0.0, 10, 10, 60 | |

## 6. What each part does
* `public/index.html` – the whole HotelSuite screen (same modules as before). It keeps a working copy in memory only; changes are sent to the server a moment after each save, other computers' changes arrive every 15 seconds, and simultaneous edits to the same record are detected (the first save wins, the other user is told and sees the latest version).
* `src/server.js` – sign-in, sessions, permissions, data sync, document numbering, user administration, clock-in PIN check, audit trail, import/export.
* `src/billing.js` – the nightly room-billing job. `src/relay.js` – SMS / STK sending with protection against being pointed at internal addresses.
* `db/schema.*.sql` – PostgreSQL / SQLite tables: users, sessions, records (all business data as versioned records), history, audit_log, sequences (document numbers), roles, login_attempts, tenants.
* `test/` – 52 automated tests (`npm test`) plus a real-browser test of the windows (`npm run test:browser`, needs Chrome and puppeteer-core), including the real screen script running against the real server.

## 7. Limits you should know about
* **Needs the network.** If the connection drops, changes stay on screen and are retried; closing the tab before they are sent loses them (the browser warns you). There is no offline mode. For a site with unreliable internet, install this same package on a PC or mini-server at the hotel and back it up to the cloud.
* PostgreSQL support was written to the same SQL subset that the tests exercise on SQLite, but the automated tests could not be run against a live PostgreSQL in the build environment. Run `scripts/smoke.js` after your first deployment and do one restore test before go-live.
* Whole data set is loaded when someone signs in – comfortable for a resort (tens of thousands of records); very large histories will need archiving or paging later.
* **Backups made with File → Backup do not contain gateway keys or PIN hashes** (by design). After restoring into a new system, re-enter the SMS / STK keys and have HR set PINs again. A database-level backup (`pg_dump`, the nightly backup container) keeps them, but you also need `DATA_KEY` to read the gateway keys.
* The billing timer posts room charges only. Other daily tasks are unchanged. Billing uses the server's clock: make sure `TZ` is right.
* A gateway that expects something other than the simple JSON the system sends today (`to`, `message`, `from`, `username`; STK: `phone`, `amount`, `reference`, `description`, bearer-token header) needs a small adapter in front of it (the same as before).
* Unmatched M-Pesa: credits come from a manual entry or a pasted / uploaded statement; there is no live Daraja (C2B) feed in this package. When a settlement is approved the approver's screen writes the receipt entries; if that screen closes first, the next administrator screen completes it automatically (the audit trail shows it). A POS sale settled this way is undone with a Customer Credit Note (not from the reversal button).
* Windows live inside the one browser tab (closing or reloading the tab closes them all; a sign-out ends them all). The window feature was tested in Chromium (Chrome / Edge); other browsers should work but were not tested.
* PINs protect the clock-in screen. A signed-in user whose role may write attendance can still add attendance records through the system; the audit trail and history show who did it.

## Help Assistant (voice & chat)

Hotel Management > Help Assistant. Answers from live rooms, rates, spa/gym items and bookings, and books spa/gym appointments,
airstrip pickups and excursions as Pending/Scheduled records marked `src: Assistant`; staff confirm or decline under
Assistant Requests. Room enquiries become requests only (no automatic reservation).

* Microphone: the `Permissions-Policy` header is now `microphone=(self)` (was `microphone=()`), and each app window's iframe
  carries `allow="microphone"`. Voice needs Chrome/Edge and HTTPS (or localhost). The browser's speech recognition may send
  audio to the browser vendor's speech service; no audio is sent to this server.
* Data: new collection `asst` (inbox) writable by Front Office and Manager and Admin; `obj:asstcfg` (setup) is Admin-only.
  If you saved custom role templates before upgrading, tick Help Assistant / Assistant Requests for the roles that need them.
* Tests: `npm test` now includes `test/assistant.test.js` (conversation engine).
