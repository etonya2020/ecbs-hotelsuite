# Deploy ECBS HotelSuite: GitHub + Cloudflare + database

## What this app is (and why it matters for Cloudflare)
It is a **Node.js server** (login, sessions, nightly billing) that stores everything in **PostgreSQL**.
It cannot run on Cloudflare Pages or plain Workers. On Cloudflare it runs in **Cloudflare Containers**
(a Worker that starts your Dockerfile; needs the Workers Paid plan, about $5/month). The database must be
**external** PostgreSQL: Neon (free tier) is the easiest. The app creates all its tables itself on first start.

## Step 1: Database (Neon, ~3 min)
1. https://neon.tech -> sign up -> New project. Region: the one nearest Kenya (e.g. Europe/Frankfurt).
2. Copy the connection string (looks like `postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`). This is your `DATABASE_URL`.
3. Nothing else to do: no tables to create.

## Step 2: GitHub
```
cd ecbs-server
git init && git add . && git commit -m "ECBS HotelSuite"
git branch -M main
# create an EMPTY PRIVATE repo on github.com first, then:
git remote add origin https://github.com/<you>/ecbs-hotelsuite.git
git push -u origin main
```
Keep the repo **private**. `.env` is git-ignored: never commit passwords. Tests run automatically (Actions tab).

## Step 3: Cloudflare Containers
Needs Node 22+, Docker running locally, a Cloudflare account on **Workers Paid**.
```
cd cloudflare
npm install
npx wrangler login
npx wrangler deploy                 # builds the Dockerfile and uploads it (first deploy takes a few minutes)
npx wrangler secret put DATABASE_URL     # paste the Neon string
npx wrangler secret put DATA_KEY         # long random text. KEEP A COPY
npx wrangler secret put ADMIN_PASSWORD   # min 10 chars; you must change it at first login
npx wrangler secret put DEV_USER         # optional
npx wrangler secret put DEV_PASSWORD     # optional
npx wrangler deploy                 # redeploy so the secrets are picked up
```
Open the `*.workers.dev` URL shown, sign in as `admin`, change the password.
Custom domain: add the domain to Cloudflare, uncomment `routes` in `cloudflare/wrangler.jsonc`, deploy again.

Auto-deploy from GitHub: add repo secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and
`CLOUDFLARE_ACCOUNT_ID`; `.github/workflows/deploy-cloudflare.yml` then deploys on every push to main.

Verify: `BASE_URL=https://<your-url> SMOKE_USER=admin SMOKE_PASSWORD='...' node scripts/smoke.js`

## Billing timer caveat (important)
Cloudflare Containers sleep when idle (`sleepAfter` in worker.js). While asleep the 05:30 room-billing job
does not fire. When the container wakes, the app posts the missed nights (correctly dated, never twice), so no
revenue is lost, but charges may appear when the first person opens the system rather than at 05:30.
If you need billing at exactly 05:30 with nobody signed in, use the always-on option below.

## Always-on alternative (recommended if you want the timer reliable)
Render (or Railway/Fly) + the same Neon database: connect the GitHub repo, "New + > Blueprint" uses `render.yaml`,
fill DATABASE_URL and ADMIN_PASSWORD. Then put the domain behind Cloudflare DNS (orange cloud proxy on).

## Backups
Neon keeps point-in-time history (check your plan's window). Also use File -> Backup (Export) in the app regularly.

## Honest notes
* The Cloudflare Containers config here was written from Cloudflare's docs and not deployed by me; if wrangler
  reports a config error, send me the message and I'll fix it. The app itself passes all 53 tests.
* The README says PostgreSQL support was not tested against a live Postgres: run the smoke test and a restore test before go-live.

## Developer panel (multi-client) - extra secrets
Add these with `npx wrangler secret put <NAME>` (or in Cloudflare > Variables and Secrets), then redeploy:
* `PLATFORM_OWNER_PASSWORD`  your panel password (min 12 chars). `PLATFORM_OWNER_USER` is optional (default `ettylinks`).
* `PLATFORM_HOST`   e.g. `platform.yourdomain.com` (panel address). Optional but recommended.
* `PLATFORM_DOMAIN` e.g. `yourdomain.com` so each client gets `code.yourdomain.com`. Optional.
Then open `https://<panel address>/platform`. Full guide: DEVELOPER-PANEL.md.

## Cloudflare-only route, multi-client (summary)
1. Domain on Cloudflare + Workers Paid plan ($5/mo). 2. Neon database. 3. Edit `cloudflare/wrangler.jsonc`: uncomment `routes`, replace yourdomain.com.
4. DNS: proxied (orange) record `*` -> AAAA `100::`. 5. GitHub secrets CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, then Actions > Deploy to Cloudflare > Run workflow.
6. Worker > Settings > Variables and Secrets (type Secret): DATABASE_URL, DATA_KEY, ADMIN_PASSWORD, PLATFORM_OWNER_PASSWORD, PLATFORM_HOST, PLATFORM_DOMAIN; run the workflow again.
7. Open https://platform.yourdomain.com. The daily cron in wrangler.jsonc wakes the sleeping server at 05:35 so room billing posts.
