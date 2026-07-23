# SKC — Bakery Supplies Operations Platform

A live inventory / delivery / production / sales system that runs a real bakery-supply
business — a central office plus four branches. Designed, built, and operated end-to-end
by a single developer: backend, web front end, desktop clients, database, and deployment.

This repo is the **central API + web app** — and, as of 2026-07-23, the sole focus of active
development. Two sibling repos complete the system:

- **[Juan23/SKC](https://github.com/Juan23/SKC)** — WinForms desktop clients (office, branch, and
  owner-admin apps). **Frozen 2026-07-23** — maintenance-only, no new features; all client-side
  admin work now goes through this repo's `SKC Admin CLI` console app instead.
- **[Juan23/skc-web](https://github.com/Juan23/skc-web)** — the public website (simplykates.com)

## What it does

Tracks stock as it moves through the business: the office buys from suppliers, ships to
branches, branches bake and decorate, then sell at the counter — every step FIFO-costed
against one PostgreSQL source of truth. The point-of-sale is **offline-first**: it keeps
selling with no network and syncs when the connection returns, so a dropped link never
stops a sale or loses one.

## Stack

- **Backend** — ASP.NET Core (.NET 8) minimal API; Dapper + Npgsql over PostgreSQL 15;
  hand-written SQL with hand-rolled, idempotent migrations
- **Web** — React + TypeScript + Vite SPA, role-scoped (office / owner / branch), served
  by the API; the POS is an offline-first PWA backed by IndexedDB
- **Infra** — Docker on a DigitalOcean droplet, kept off the public internet over
  Tailscale, HTTPS via `tailscale serve`

## Engineering highlights

- **FIFO inventory lots** consumed oldest-first across purchases, deliveries, production,
  and sales, with per-branch advisory locks so concurrent writes serialize instead of racing.
- **Idempotent offline sync** — each sale carries a client-minted GUID, so retries and
  mid-sync crashes are harmless; oversell is recorded rather than rejected, so the counter
  never blocks.
- **Layered auth** — Tailscale membership + device IP allowlists + DB-backed sessions,
  gated on both role and device.

## Running locally

```
docker compose up -d db      # Postgres
dotnet run                   # API (ports in Properties/launchSettings.json)
cd webapp && npm run build   # builds the SPA into ../wwwroot
```

The SPA ships inside the API image. Changes reach the droplet through a
build → scp → migrate → rebuild-container → curl-smoke flow; there's no staging
environment, so verification runs against the live API.
