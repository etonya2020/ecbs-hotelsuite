# Ettylinks Developer Panel (multi-client control)

One running ECBS server can host **many organisations**. Each has its own private data, users, licence and package.
You control all of it from the Developer Panel at **`/platform`** (own sign-in, separate from every client's login).

## First sign-in
Set secrets `PLATFORM_OWNER_USER` (default `ettylinks`) and `PLATFORM_OWNER_PASSWORD` before the first start.
Open `https://<your-address>/platform`, sign in, choose your own password when asked.
If you do not set a password the server prints a one-time one in its log at first start.

## What you can do
| Screen | Purpose |
|---|---|
| Dashboard | clients by status, monthly recurring revenue, payments in last 30 days, overdue licences, renewals due |
| Organisations | list/search; **New organisation** deploys a client (private data space + admin login + licence + address) |
| Organisation > Package & modules | pick the package, tick/untick any module for just this client, per-client user limit and price |
| Organisation > Billing | record a payment (extends the licence by the paid periods), manual dates, history |
| Organisation > Details | contact, notes, web addresses; Users tab: reset the client administrator's password |
| Packages | create packages: modules included, price, billing cycle, max users, trial days; editing updates every client on it at once |
| Payments / Activity log | everything recorded, with who did it |
| Platform team | Platform Owner (everything) or Platform Support (view, reset passwords, notes only) |

## What a package switches on/off
Sales & POS, M-Pesa & Payment Gateway, Rooms & Front Office, Hotel Management, Help Assistant, Gym & Spa,
Functions & Ticketing, Stores/Inventory/Assets, Procurement & Suppliers, Accounts & Banking, HR & Payroll, SMS.
Switched-off modules vanish from the client's menus **and the server refuses their data changes** (and SMS / M-Pesa /
room-billing actions), so it cannot be bypassed from the browser. Their stored data is kept if you switch a module back on.

## Charging
Each package has a price and cycle (monthly / quarterly / 6-monthly / yearly). Recording a payment moves the
client's **licensed-until** date forward and re-activates them. When the date passes (plus the 7-day grace in the
client's licence) their system becomes **read-only**; **Suspend** blocks sign-in completely. The client sees the
trial/expiry warnings in their own app, because the panel keeps their licence record in step.

## How a client reaches its own site
The server picks the organisation from the **web address**:
1. Addresses you type in *Organisation > Details* (e.g. `hotel.client.co.ke`), or
2. `code.PLATFORM_DOMAIN` automatically (secret `PLATFORM_DOMAIN=yourdomain.com` -> `savannah.yourdomain.com`).
Unknown addresses show "organisation address is not active" and never create data.

### Cloudflare setup for this
* Put the panel on its own address: custom domain `platform.yourdomain.com` on the Worker, secret `PLATFORM_HOST=platform.yourdomain.com`.
  The client app is never served on that address and the panel is never served on a client's address.
* For automatic client addresses: DNS record `*` (proxied) + route `*.yourdomain.com/*`, secret `PLATFORM_DOMAIN=yourdomain.com`.
  Use a **dedicated domain** for this (the wildcard sends every subdomain to the app).
* Or add each client's own domain as a custom domain on the Worker and type it in the client's *Details*.
