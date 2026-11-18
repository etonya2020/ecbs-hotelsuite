# ECBS HotelSuite – Cloudflare edition (3.0.0-cloudflare.1)

Runs on **GitHub + Cloudflare only**: a Worker serves the page and API, and one **Durable Object per hotel** holds that
hotel's SQLite database and runs the nightly room billing (alarm, once a minute). The Node/PostgreSQL edition (README-DEPLOY.md)
still works from the same code.

```
Browser → Worker (cf/worker.mjs) → Tenant Durable Object → its own SQLite database
                                        └─ alarm every minute → nightly room billing
```

## What you need
* A free GitHub account and a free Cloudflare account.
* **Workers Paid plan ($5/month)** is strongly advised: password hashing (scrypt) takes far more CPU than the free plan's
  per-request limit. Without it, logins will fail with CPU-limit errors.

## 1. Put the code on GitHub
1. GitHub → **New repository** → name `ecbs-hotelsuite` → **Private**.
2. Upload the contents of this folder (GitHub web: *Add file → Upload files*, or `git push`). Make sure `.github/` comes with it.
3. Create the two branches: `main` (real) and `dev` (testing). Work on `dev`; merge into `main` when happy.

## 2. Cloudflare access for GitHub
1. Cloudflare dashboard → **Workers & Pages** (this also creates your `*.workers.dev` address – pick a subdomain if asked).
2. **My Profile → API Tokens → Create Token → template "Edit Cloudflare Workers"** → copy the token.
3. Copy your **Account ID** (right side of the Workers & Pages overview).
4. GitHub repo → **Settings → Environments** → create `staging` and `production`. In *each*, add secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | your Account ID |
| `ADMIN_PASSWORD` | first administrator's password (10+ characters, mixed) |
| `DEV_PASSWORD` | developer account password |
| `DATA_KEY` | long random text – **keep a copy elsewhere**; without it SMS / M-Pesa keys cannot be read |
| `OPS_TOKEN` | long random text (16+ characters) for the operator endpoint |

Use different values for `staging` and `production`.

## 3. Deploy
* Push to **`dev`** → tests run, then the **staging** copy deploys: `https://ecbs-hotelsuite-staging.<your-subdomain>.workers.dev`
* Push/merge to **`main`** → tests run, then **production** deploys: `https://ecbs-hotelsuite.<your-subdomain>.workers.dev`

Watch it under the repo's **Actions** tab. Open the address, sign in as `admin` with `ADMIN_PASSWORD`, and change the password when asked.

Staging and production are completely separate (own Durable Object, own database), so you can test freely on staging.

## 4. Several hotels (clients)
Each hotel is its own Durable Object with its own database. Map an address to a hotel in `wrangler.jsonc`:
`"TENANT_MAP": "hotelb.example.com=hotelb"`. Create that hotel's first user:
```
curl -X POST "https://<your-worker>/_ops/user?tenant=hotelb" \
  -H "Authorization: Bearer <OPS_TOKEN>" -H "Content-Type: application/json" \
  -d '{"username":"boss","role":"Admin"}'
```
The reply contains a one-time password (must be changed at first login). Add `"reset":true` to reset an existing user.

## 5. Later: your own domain
Add the domain to Cloudflare, then add to `wrangler.jsonc` (top level): `"routes": [{ "pattern": "hotel.yourdomain.com", "custom_domain": true }]`
and push. Data does not move; only the address changes. Optional: **Cloudflare Access** in front of the admin screens.

## 6. Run it on your own computer
`npm install`, copy `.dev.vars.example` to `.dev.vars`, then `npm run cf:dev` (http://localhost:8787). Tests: `npm test` (everything),
`npm run test:cf` (whole suite through the Cloudflare path).

## Moving data
Existing Node/Postgres hotel → **Admin → Export** there, **Import** here (the import screen already exists). Gateway keys and PIN hashes are not exported.

## Backups
* Durable Object SQLite keeps **30 days of point-in-time history** on Cloudflare's side.
* Also take a regular **Admin → Export** download; keep it off Cloudflare.

## Differences from the Node edition – read these
* **Time zone:** Workers always run in UTC; billing time uses `TZ` (Africa/Nairobi) through `src/tz.js`.
* **Records are limited to ~900 KB** (`MAX_REC_KB`) because a database row is limited to 2 MB. Embedded photos should be small.
* **Transactions:** Durable Object SQLite has no async `BEGIN`; `cf/sql-adapter.js` serialises work and keeps an undo journal
  (triggers) so a failed or interrupted transaction is rolled back. If the triggers cannot be created, a warning is logged and the server runs without rollback.
* **Free-plan write limits:** the undo journal roughly triples rows written. Big imports or very busy hotels need the Paid plan.
* **SMS / STK relay** uses `fetch` (HTTPS only). Private-address checks still apply to literal IPs.
* The "first run" generated password (when `ADMIN_PASSWORD` is unset) is written to the Worker logs (`npm run cf:tail`). Set the secret instead.

## Honest status
Verified here: the whole 53-test suite plus 11 Cloudflare tests pass on a **simulation** (Worker → Durable Object → SQLite adapter on Node's SQLite).
**Not verified:** a real `wrangler dev` / deploy – this environment has no network. The first real run may surface platform
differences; if the Worker fails to start, run `npm run cf:tail` (or `npx wrangler dev`) and send the first error. The most likely ones:
* *"Dynamic require of … is not supported"* – a bundling setting for Node built-ins;
* *"CPU time limit exceeded"* on login – you are on the free plan (or lower `SCRYPT_N`);
* *trigger / PRAGMA not allowed* – logged as a warning; the app keeps running without rollback.
