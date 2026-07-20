# SKC API

Central ASP.NET Core API for the SKC inventory / delivery / production / sales system —
the server side of SKC Bakery Supplies' internal operations (central office + branches:
Yoho, Gaisano, Liloy, Labason). The client-side WinForms apps live in the separate
`Juan23/SKC.git` repo.

## Stack

- .NET 8 minimal API — single `Program.cs` (endpoints + Dapper DTOs, no layers)
- Dapper + Npgsql against Postgres 15, hand-written SQL (no ORM, no migrations framework)
- Deployed as a Docker container on a Digital Ocean droplet, reached over Tailscale

## Running locally

```
dotnet build
docker compose up -d db        # just Postgres
dotnet run                     # HTTPS 53755, HTTP 53756 (see Properties/launchSettings.json)
```

Full container rebuild (as done on the droplet):

```
docker compose build api && docker compose up -d api
```

## Endpoints

| Area | Endpoints |
|---|---|
| Health | `GET /health` |
| Purchases | `POST /api/purchases`, `GET /api/purchases/tickets`, `GET/DELETE /api/purchases/{id}` |
| Deliveries | `POST /api/deliveries`, `GET /api/deliveries/tickets`, `GET/DELETE /api/deliveries/{id}`, `GET /api/deliveries/daily`, `GET /api/deliveries/pending`, `POST /api/deliveries/{transactionId}/accept` |
| Inventory | `GET /api/inventory`, `GET /api/inventory/branch/{branch}`, `POST /api/inventory`, `PUT /api/inventory/{sku}`, `PATCH /api/inventory/{sku}/deactivate`, `PUT /api/inventory/{sku}/classification`, `PUT /api/inventory/{sku}/price`, `POST /api/inventory/{sku}/adjust`, `GET /api/inventory/adjustments` |
| Recipes | `GET /api/recipes`, `GET /api/recipes/{id}`, `POST /api/recipes`, `PUT /api/recipes/{id}`, `PATCH /api/recipes/{id}/deactivate` |
| Production | `POST /api/production` (baking & decorating share this), `GET /api/production` |
| POS sales | `POST /api/sales` (batch sync), `GET /api/sales`, `GET /api/sales/lines` (flat line-level range, for the branch report's CSV export), `GET /api/sales/{branch}/{clientSaleId}`, `POST /api/sales/{branch}/{clientSaleId}/void` |

## Domain rules worth knowing

- **FIFO lots everywhere.** Purchases create `inventory_lots`; deliveries, production,
  and sales consume them oldest-first. A delivery ticket can span multiple
  `delivery_logs` rows (one per lot chunk), all sharing one `transaction_id` — status,
  accept, and delete always operate on the whole ticket, never a single row.
- **Sales sync is idempotent** on `(branch_name, client_sale_id)`; re-pushing after a
  client crash returns `AlreadySynced`. Oversell is warn-but-allow: uncovered quantity
  is recorded as `shortfall_qty` and the sale returns `SyncedWithShortfall`.
- **Sellable = `price > 0`.** Which categories a POS shows is a client-side filter,
  not a server rule.
- **Concurrency:** every multi-statement write opens an explicit transaction, takes a
  per-branch advisory lock (`pg_advisory_xact_lock(hashtext('inventory-write:' || branch))`),
  and uses `SELECT ... FOR UPDATE` before mutating rows. Follow this for any new write
  endpoint.

## Security model

There is no staff auth — Tailscale network membership is the primary trust boundary,
plus three IP allowlists in `Program.cs`:

- **Office allowlist** gates office-only writes (purchases, delivery create/delete,
  inventory catalog/classification/adjust).
- **Owner allowlist** (stricter) gates recipe management and selling-price changes.
- **Per-branch allowlist** (`branchIps`) gates branch-initiated writes: accept delivery,
  production, sales sync, and sale void. On `/accept` the gate keys on the ticket's
  DB-verified `to_branch`, not the client-asserted branch name.

A branch **absent** from `branchIps` fails open by design — most branches aren't on
Tailscale yet, so gating them would break their real operations. Only `Yoho` is populated
so far; add new branches to that same dictionary as they onboard. For any endpoint not
yet covered by an allowlist (including every `GET`), strict input validation is the only
protection — so keep it strict.

## Schema & migrations

- `init_schema.sql` — from-scratch schema for fresh installs.
- `migrations/NNN_description.sql` — hand-written, idempotent, sequential; applied
  manually via `psql` on the droplet, **before** the new API image is deployed.
  Update `init_schema.sql` in the same change so both paths converge.

## Testing

No automated test suite and no staging environment. Verification is: local
`dotnet build` → `scp` changed files to the droplet → apply any migration → rebuild
the container → `curl` smoke tests against the live API (happy path + edge cases).
`docker logs central_api_service --tail 50` shows real exceptions when something 500s.
