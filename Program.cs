using System;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Dapper;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection");

var app = builder.Build();

// Office/owner IP allowlist. Tailscale assigns each device on the tailnet a stable 100.x
// address, so checking the caller's remote IP is a real server-side restriction rather than
// trusting whoever has a copy of the client exe. Only two entries exist today - there's no
// branches table or auth system yet, so per-branch entries get added here once each branch
// PC joins Tailscale (branch-initiated endpoints like /accept aren't gated yet for that reason).
var trustedOfficeIps = new HashSet<string>
{
    "100.66.61.24",  // SKC Bakery Supplies office PC
    "100.108.218.24" // Owner's laptop
};

bool IsTrustedOfficeCaller(HttpContext http)
{
    var ip = http.Connection.RemoteIpAddress;
    if (ip == null) return false;
    if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
    return trustedOfficeIps.Contains(ip.ToString());
}

// Recipes are the owner's alone (branches never see recipe management, only the
// finished recipe list read-only for production entry) - stricter than the
// general office allowlist above, which also includes the office PC.
const string OwnerIp = "100.108.218.24";

bool IsOwnerCaller(HttpContext http)
{
    var ip = http.Connection.RemoteIpAddress;
    if (ip == null) return false;
    if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
    return ip.ToString() == OwnerIp;
}

// Shared validation for recipe create/update. Kind mirrors the DB's chk_recipe_kind
// constraint and quantities must be positive, so a bad value gets a clean 400 instead of
// either a raw Postgres constraint-violation message or a recipe that silently produces
// nothing (see POST /api/production's OutputQty=0 case for what a zero-qty recipe does).
string? ValidateRecipeDto(RecipeDto dto)
{
    if (dto.Kind != "Baking" && dto.Kind != "Decorating")
        return "Kind must be Baking or Decorating.";
    if (dto.OutputQty <= 0)
        return "OutputQty must be greater than zero.";
    if (dto.Lines.Any(l => l.Qty <= 0))
        return "Each recipe line's Qty must be greater than zero.";
    return null;
}

// Endpoints
app.MapGet("/health", () => Results.Ok(new { Status = "Healthy" }));

app.MapPost("/api/purchases", async (List<PurchaseLogDto> purchases, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);
    // A zero/negative Qty used to silently no-op (no lot created, no error) instead of being
    // rejected - reject it up front so a bad line fails the whole ticket instead of vanishing.
    if (purchases.Any(p => p.Qty <= 0)) return Results.BadRequest("Qty must be greater than zero for every purchase line.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var transaction = await db.BeginTransactionAsync();

    try
    {
        // Serialize concurrent writers on this branch so the MAX()+1 ID assignment below can't race.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: transaction);

        // Idempotency: if this ticket's transaction_id already committed (the client re-submitted
        // after a lost response), don't create the lots/logs a second time. All lines of one submit
        // share a single client-minted transaction_id.
        if (purchases.Count > 0)
        {
            var txId = purchases[0].TransactionId;
            if (!string.IsNullOrWhiteSpace(txId))
            {
                int existing = await db.ExecuteScalarAsync<int>(
                    "SELECT COUNT(*) FROM purchase_logs WHERE transaction_id = @txId", new { txId }, transaction);
                if (existing > 0) { await transaction.CommitAsync(); return Results.Ok(); }
            }
        }

        // 1. Grab the highest existing IDs to simulate auto-increment
        int nextPurchaseId = await db.ExecuteScalarAsync<int>("SELECT COALESCE(MAX(local_id), 0) FROM purchase_logs WHERE branch_name = 'Office'", transaction);
        int nextLotId = await db.ExecuteScalarAsync<int>("SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = 'Office'", transaction);

        foreach (var p in purchases)
        {
            nextPurchaseId++;
            nextLotId++;

            // 2. Insert with the generated Local IDs
            await db.ExecuteAsync(@"
                INSERT INTO purchase_logs (branch_name, local_id, transaction_id, date, sku, qty, unit_cost, supplier)
                VALUES ('Office', @LocalId, @TransactionId, @Date, @SKU, @Qty, @UnitCost, @Supplier)",
                new { LocalId = nextPurchaseId, p.TransactionId, p.Date, p.SKU, p.Qty, p.UnitCost, p.Supplier }, transaction);

            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost, purchase_transaction_id)
                VALUES ('Office', @LotId, @SKU, @Date, @Qty, @Qty, @UnitCost, @TransactionId)",
                new { LotId = nextLotId, p.SKU, p.Date, p.Qty, p.UnitCost, p.TransactionId }, transaction);
        }
        await transaction.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex)
    {
        await transaction.RollbackAsync();
        return Results.Problem(ex.Message);
    }
});
app.MapPost("/api/deliveries", async (List<DeliveryLogDto> deliveries, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);
    // Same as purchases: a zero/negative Qty used to silently no-op instead of being rejected.
    if (deliveries.Any(d => d.Qty <= 0)) return Results.BadRequest("Qty must be greater than zero for every delivery line.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var transaction = await db.BeginTransactionAsync();

    try
    {
        // Serialize concurrent writers on this branch: protects the MAX()+1 ID assignment below,
        // and also stops two concurrent deliveries from both reading the same lot's remaining_qty
        // before either commits (see the FOR UPDATE on the lot query below for the same reason).
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: transaction);

        // Idempotency: a re-submit of the same transaction_id (client didn't hear back after a
        // committed request) returns the already-recorded rows for printing instead of deducting
        // Office stock and inserting the ticket a second time. All lines share one transaction_id.
        if (deliveries.Count > 0)
        {
            var txId = deliveries[0].TransactionId;
            if (!string.IsNullOrWhiteSpace(txId))
            {
                var existing = (await db.QueryAsync<DeliveryLog>(
                    @"SELECT transaction_id AS TransactionId, date AS Date, sku AS SKU, qty AS Qty, to_branch AS ToBranch,
                             total_line_cost AS TotalLineCost, requester AS Requester, reason AS Reason
                      FROM delivery_logs WHERE transaction_id = @txId", new { txId }, transaction)).ToList();
                if (existing.Count > 0) { await transaction.CommitAsync(); return Results.Ok(existing); }
            }
        }

        int nextDeliveryId = await db.ExecuteScalarAsync<int>("SELECT COALESCE(MAX(local_id), 0) FROM delivery_logs WHERE branch_name = 'Office'", transaction);
        var insertedRows = new List<DeliveryLog>();

        foreach (var d in deliveries)
        {
            int qtyNeeded = d.Qty;

            // Strongly-typed query: Postgres folds unquoted "AS LotId"/"AS RemainingQty" aliases to
            // lowercase, so the dynamic (non-generic) QueryAsync overload used previously silently
            // returned null for lot.LotId/lot.RemainingQty (case-sensitive dynamic member lookup),
            // which crashed the (int) cast below. QueryAsync<LotRow> maps columns case-insensitively.
            // date_received only carries a date (no time), so purchases entered on the same day
            // tie on the first sort key; lot_id (assigned in purchase order) breaks the tie so FIFO
            // stays deterministic instead of depending on Postgres's arbitrary tie-break order.
            // FOR UPDATE locks these rows so a concurrent request touching the same SKU has to wait
            // instead of reading the same pre-deduction remaining_qty (which would let both requests
            // deduct from the same stock and drive remaining_qty negative).
            // branch_name = 'Office' throughout: deliveries only ever draw from Office stock,
            // and lot_id is only unique per branch (UNIQUE (branch_name, lot_id)), so an
            // unscoped WHERE lot_id would also hit a same-numbered lot in another branch.
            var lots = await db.QueryAsync<LotRow>(@"
                SELECT lot_id AS LotId, remaining_qty AS RemainingQty, unit_cost AS UnitCost
                FROM inventory_lots
                WHERE sku = @SKU AND remaining_qty > 0 AND branch_name = 'Office'
                ORDER BY date_received ASC, lot_id ASC
                FOR UPDATE", new { d.SKU }, transaction);

            foreach (var lot in lots)
            {
                if (qtyNeeded <= 0) break;

                int qtyToTake = Math.Min(qtyNeeded, lot.RemainingQty);
                qtyNeeded -= qtyToTake;
                decimal chunkCost = qtyToTake * lot.UnitCost;

                await db.ExecuteAsync(@"
                    UPDATE inventory_lots
                    SET remaining_qty = remaining_qty - @Take
                    WHERE lot_id = @LotId AND branch_name = 'Office'",
                    new { Take = qtyToTake, LotId = lot.LotId }, transaction);

                nextDeliveryId++;
                await db.ExecuteAsync(@"
                    INSERT INTO delivery_logs (branch_name, local_id, transaction_id, date, sku, qty, to_branch, total_line_cost, requester, reason)
                    VALUES ('Office', @LocalId, @TransactionId, CAST(@Date AS TIMESTAMP), @SKU, @Qty, @ToBranch, @TotalLineCost, @Requester, @Reason)",
                    new { LocalId = nextDeliveryId, d.TransactionId, d.Date, d.SKU, Qty = qtyToTake, d.ToBranch, TotalLineCost = chunkCost, d.Requester, d.Reason }, transaction);

                insertedRows.Add(new DeliveryLog
                {
                    TransactionId = d.TransactionId,
                    Date = DateTime.Parse(d.Date),
                    SKU = d.SKU,
                    Qty = qtyToTake,
                    ToBranch = d.ToBranch,
                    TotalLineCost = chunkCost,
                    Requester = d.Requester,
                    Reason = d.Reason
                });
            }

            if (qtyNeeded > 0)
                throw new Exception($"Insufficient inventory for SKU: {d.SKU}. Short by {qtyNeeded}.");
        }
        await transaction.CommitAsync();
        return Results.Ok(insertedRows);
    }
    catch (Exception ex)
    {
        await transaction.RollbackAsync();
        return Results.Problem(ex.Message);
    }
});

// --- HISTORY & VIEW ENDPOINTS ---
app.MapGet("/api/purchases/tickets", async (DateTime start, DateTime end) => {
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"SELECT transaction_id AS TransactionId, date AS Date, supplier AS Supplier, SUM(qty * unit_cost) AS TotalAmount 
                FROM purchase_logs WHERE date >= @start AND date <= @end GROUP BY transaction_id, date, supplier ORDER BY date DESC";
    return Results.Ok(await db.QueryAsync<PurchaseTicketSummary>(sql, new { start, end }));
});

app.MapGet("/api/purchases/{id}", async (string id) => {
    using var db = new NpgsqlConnection(connectionString);
    return Results.Ok(await db.QueryAsync<PurchaseLog>("SELECT transaction_id AS TransactionId, date AS Date, sku AS SKU, qty AS Qty, unit_cost AS UnitCost, supplier AS Supplier FROM purchase_logs WHERE transaction_id = @id", new { id }));
});

app.MapDelete("/api/purchases/{id}", async (string id, HttpContext http) => {
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        var lines = await db.QueryAsync("SELECT sku, qty, unit_cost FROM purchase_logs WHERE transaction_id = @id", new { id }, tx);
        foreach (var line in lines)
        {
            // Matches lots back to this specific purchase ticket via purchase_transaction_id rather
            // than sku+qty+unit_cost, which could otherwise match (and delete) lots belonging to a
            // different ticket that happened to share the same sku/qty/cost.
            int consumed = await db.ExecuteScalarAsync<int>(
                "SELECT COALESCE(SUM(original_qty - remaining_qty), 0) FROM inventory_lots WHERE purchase_transaction_id = @id AND sku = @sku",
                new { id, sku = line.sku }, tx);
            if (consumed > 0) throw new Exception($"Cannot delete ticket: {line.sku} has already been used in deliveries.");

            await db.ExecuteAsync("DELETE FROM inventory_lots WHERE purchase_transaction_id = @id AND sku = @sku", new { id, sku = line.sku }, tx);
        }
        await db.ExecuteAsync("DELETE FROM purchase_logs WHERE transaction_id = @id", new { id }, tx);
        await tx.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapGet("/api/deliveries/tickets", async (DateTime start, DateTime end) => {
    using var db = new NpgsqlConnection(connectionString);
    // Compare on ::date, not the raw timestamp: delivery_logs.date carries a time component
    // (Delivery.cs stamps DateTime.Now), so a plain `date <= @end` with a date-only end (midnight)
    // silently drops every same-day delivery. Casting both sides to date makes the range whole-day
    // inclusive regardless of what time the client sends - same idea as /api/deliveries/daily's date().
    var sql = @"SELECT transaction_id AS TransactionId, date AS Date, to_branch AS ToBranch, SUM(qty) AS TotalItems,
                       MAX(requester) AS Requester, MAX(reason) AS Reason, SUM(total_line_cost) AS TotalCost,
                       MIN(status) AS Status
                FROM delivery_logs WHERE date::date >= @start::date AND date::date <= @end::date GROUP BY transaction_id, date, to_branch ORDER BY date DESC";
    return Results.Ok(await db.QueryAsync<DeliveryTicketSummary>(sql, new { start, end }));
});

app.MapGet("/api/deliveries/{id}", async (string id) => {
    using var db = new NpgsqlConnection(connectionString);
    return Results.Ok(await db.QueryAsync<DeliveryLog>("SELECT transaction_id AS TransactionId, date AS Date, sku AS SKU, qty AS Qty, to_branch AS ToBranch, total_line_cost AS TotalLineCost, requester AS Requester, reason AS Reason FROM delivery_logs WHERE transaction_id = @id", new { id }));
});

app.MapDelete("/api/deliveries/{id}", async (string id, HttpContext http) => {
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        // Serialize concurrent writers on this branch so the MAX()+1 lot ID assignment below can't race.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: tx);

        int acceptedRows = await db.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM delivery_logs WHERE transaction_id = @id AND status = 'Accepted'", new { id }, tx);
        if (acceptedRows > 0) throw new Exception("Cannot delete: this ticket has already been accepted by the branch.");

        var lines = await db.QueryAsync("SELECT sku, qty, total_line_cost FROM delivery_logs WHERE transaction_id = @id", new { id }, tx);
        int nextLotId = await db.ExecuteScalarAsync<int>("SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = 'Office'", tx);
        foreach (var item in lines)
        {
            if (item.qty > 0)
            {
                nextLotId++;
                decimal unitCost = item.total_line_cost / item.qty;
                await db.ExecuteAsync(@"INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                                        VALUES ('Office', @LotId, @sku, CURRENT_TIMESTAMP, @qty, @qty, @cost)",
                                        new { LotId = nextLotId, sku = item.sku, qty = item.qty, cost = unitCost }, tx);
            }
        }
        await db.ExecuteAsync("DELETE FROM delivery_logs WHERE transaction_id = @id", new { id }, tx);
        await tx.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapGet("/api/deliveries/daily", async (DateTime targetDate) => {
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"SELECT d.transaction_id AS TransactionId, d.to_branch AS ToBranch, d.requester AS Requester, d.reason AS Reason, d.sku AS SKU, i.base_name AS BaseName, i.brand AS Brand, d.qty AS Qty, d.total_line_cost AS TotalLineCost 
                FROM delivery_logs d LEFT JOIN inventory i ON d.sku = i.sku 
                WHERE date(d.date) = date(@targetDate) ORDER BY d.to_branch, d.transaction_id, i.brand, i.base_name";
    return Results.Ok(await db.QueryAsync<DailyDeliveryPrintItem>(sql, new { targetDate }));
});

// --- BRANCH ACCEPTANCE WORKFLOW ---

app.MapGet("/api/deliveries/pending", async (string branch) => {
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"SELECT transaction_id AS TransactionId, date AS Date, to_branch AS ToBranch, SUM(qty) AS TotalItems,
                       MAX(requester) AS Requester, MAX(reason) AS Reason, SUM(total_line_cost) AS TotalCost,
                       MIN(status) AS Status
                FROM delivery_logs WHERE to_branch = @branch AND status = 'InTransit'
                GROUP BY transaction_id, date, to_branch ORDER BY date ASC";
    return Results.Ok(await db.QueryAsync<DeliveryTicketSummary>(sql, new { branch }));
});

app.MapPost("/api/deliveries/{transactionId}/accept", async (string transactionId, AcceptDeliveryDto dto) => {
    if (string.IsNullOrWhiteSpace(dto.AcceptedBy)) return Results.BadRequest("AcceptedBy is required.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        // Lock the ticket's rows so concurrent accepts (double-click, two devices)
        // serialize instead of both succeeding.
        var rows = (await db.QueryAsync(
            "SELECT to_branch, status, sku, qty, total_line_cost FROM delivery_logs WHERE transaction_id = @transactionId FOR UPDATE",
            new { transactionId }, tx)).ToList();

        if (rows.Count == 0)
        {
            await tx.RollbackAsync();
            return Results.NotFound($"No delivery found for ticket {transactionId}.");
        }
        if (rows[0].to_branch != dto.Branch)
        {
            await tx.RollbackAsync();
            return Results.BadRequest($"Ticket {transactionId} is addressed to {rows[0].to_branch}, not {dto.Branch}.");
        }
        if (rows.Any(r => r.status != "InTransit"))
        {
            await tx.RollbackAsync();
            return Results.Conflict($"Ticket {transactionId} has already been accepted.");
        }

        // Credit the receiving branch's own FIFO ledger with one lot per delivery_logs row
        // consumed. Each row already corresponds to exactly one FIFO chunk taken from Office,
        // so total_line_cost / qty recovers that chunk's original unit cost exactly (same
        // recompute idiom already used above in DELETE /api/deliveries/{id}).
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @Branch))", new { dto.Branch }, tx);
        int nextLotId = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = @Branch", new { dto.Branch }, tx);
        foreach (var row in rows)
        {
            if (row.qty <= 0) continue;
            nextLotId++;
            decimal unitCost = row.total_line_cost / row.qty;
            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                VALUES (@Branch, @LotId, @sku, CURRENT_TIMESTAMP, @qty, @qty, @UnitCost)",
                new { dto.Branch, LotId = nextLotId, sku = row.sku, qty = row.qty, UnitCost = unitCost }, tx);
        }

        await db.ExecuteAsync(@"UPDATE delivery_logs
            SET status = 'Accepted', accepted_by = @AcceptedBy, accepted_at = CURRENT_TIMESTAMP
            WHERE transaction_id = @transactionId", new { dto.AcceptedBy, transactionId }, tx);
        await tx.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});


app.MapGet("/api/inventory", async () =>
{
    using var db = new NpgsqlConnection(connectionString);
    // Scoped to Office explicitly: now that branches can hold their own credited lots
    // (see POST /api/deliveries/{id}/accept), an unscoped SUM here would blend every
    // branch's stock into the central/office figure this endpoint is meant to report.
    var products = await db.QueryAsync(@"
        SELECT
            i.sku AS SKU,
            i.brand AS Brand,
            i.base_name AS BaseName,
            i.price AS Price,
            i.category AS Category,
            i.uom AS Uom,
            i.pack_multiplier AS PackMultiplier,
            COALESCE((SELECT SUM(remaining_qty) FROM inventory_lots l WHERE l.sku = i.sku AND l.branch_name = 'Office'), 0) AS CurrentStock
        FROM inventory i
        WHERE i.is_active = true");
    return Results.Ok(products);
});

app.MapGet("/api/inventory/branch/{branch}", async (string branch) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var products = await db.QueryAsync(@"
        SELECT
            i.sku AS SKU,
            i.brand AS Brand,
            i.base_name AS BaseName,
            i.price AS Price,
            i.category AS Category,
            i.uom AS Uom,
            i.pack_multiplier AS PackMultiplier,
            COALESCE((SELECT SUM(remaining_qty) FROM inventory_lots l WHERE l.sku = i.sku AND l.branch_name = @branch), 0) AS CurrentStock
        FROM inventory i
        WHERE i.is_active = true", new { branch });
    return Results.Ok(products);
});

app.MapPost("/api/inventory", async (InventoryItemDto product, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    // Validate up front like every other write - the UI guards these today, but the endpoint
    // shouldn't rely on that (a blank SKU would hit the PK, a negative price is just bad data).
    if (string.IsNullOrWhiteSpace(product.SKU) || string.IsNullOrWhiteSpace(product.BaseName))
        return Results.BadRequest("SKU and BaseName are required.");
    if (product.Price < 0)
        return Results.BadRequest("Price cannot be negative.");

    using var db = new NpgsqlConnection(connectionString);
    try
    {
        await db.ExecuteAsync(@"
            INSERT INTO inventory (sku, brand, base_name, price, is_active) 
            VALUES (@SKU, @Brand, @BaseName, @Price, @IsActive)", product);
        return Results.Ok();
    }
    catch (PostgresException ex) when (ex.SqlState == "23505") // 23505 is PostgreSQL's Unique Violation code
    {
        return Results.Conflict("Duplicate SKU");
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.MapPut("/api/inventory/{sku}", async (string sku, UpdateProductDto dto, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(
        "UPDATE inventory SET brand = @Brand, base_name = @BaseName, last_updated = CURRENT_TIMESTAMP WHERE sku = @sku",
        new { dto.Brand, dto.BaseName, sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

app.MapPatch("/api/inventory/{sku}/deactivate", async (string sku, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(
        "UPDATE inventory SET is_active = false, last_updated = CURRENT_TIMESTAMP WHERE sku = @sku", new { sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// Sets a product's production category and purchase-unit conversion. Office-gated
// (not owner-only) per the user's instruction: only SKC Bakery Supply edits this.
app.MapPut("/api/inventory/{sku}/classification", async (string sku, ClassifyInventoryDto dto, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    if (dto.Category != "RawMaterial" && dto.Category != "BakedGood" && dto.Category != "DecoratedGood" && dto.Category != "Miscellaneous")
        return Results.BadRequest("Category must be RawMaterial, BakedGood, DecoratedGood, or Miscellaneous.");

    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(@"
        UPDATE inventory
        SET category = @Category, uom = @Uom, pack_multiplier = @PackMultiplier, last_updated = CURRENT_TIMESTAMP
        WHERE sku = @sku",
        new { dto.Category, dto.Uom, dto.PackMultiplier, sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// Sets a product's selling price - the single company-wide price list the POS sells at.
// Sellable = price > 0 (chiffon, e.g., is a BakedGood but an unsellable intermediary, so it
// stays at 0), and each POS additionally narrows by category: SKC Branch excludes
// RawMaterial, the SKC Bakery Supplies office POS sells RawMaterial + Miscellaneous only,
// both filtered client-side per app (see each app's PosLocalStore), not here.
// Owner-gated (like recipes): prices are managed from the SKC Admin app only, though the
// office app's Add Item still sets an initial price at product creation.
app.MapPut("/api/inventory/{sku}/price", async (string sku, SetPriceDto dto, HttpContext http) =>
{
    if (!IsOwnerCaller(http)) return Results.Problem("This endpoint is restricted to the owner's device.", statusCode: 403);

    if (dto.Price < 0) return Results.BadRequest("Price cannot be negative.");

    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(
        "UPDATE inventory SET price = @Price, last_updated = CURRENT_TIMESTAMP WHERE sku = @sku",
        new { dto.Price, sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// Reconciles a branch's stock with a physical count. Used when a manual inventory
// count (see the client's "print all inventory" count sheet) finds a discrepancy.
// Branch defaults to 'Office' (central stock) but can target any branch's own lots.
app.MapPost("/api/inventory/{sku}/adjust", async (string sku, AdjustInventoryDto dto, HttpContext http) =>
{
    if (!IsTrustedOfficeCaller(http)) return Results.Problem("This endpoint is restricted to trusted office devices.", statusCode: 403);

    // A physical count can't be negative. Without this, a negative NewCount makes the
    // shrinkage branch below try to remove more stock than currentTotal actually holds -
    // the FIFO loop just exhausts early, but qty_delta/costUsed still get recorded against
    // the full (un-clamped) requested delta, desyncing inventory_adjustments from what
    // inventory_lots actually changed by.
    if (dto.NewCount < 0) return Results.BadRequest("NewCount cannot be negative.");

    string branch = string.IsNullOrWhiteSpace(dto.Branch) ? "Office" : dto.Branch;

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var transaction = await db.BeginTransactionAsync();

    try
    {
        // Serialize concurrent writers on this branch: protects the MAX()+1 lot ID assignment below,
        // and (together with the FOR UPDATE in the shrinkage branch) stops a concurrent delivery or
        // adjustment from reading the same lot's remaining_qty before either commits.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @branch))", new { branch }, transaction);

        // Every read/write is scoped to @branch: lot_id is only unique per branch
        // (UNIQUE (branch_name, lot_id)), so an unscoped currentTotal would sum other
        // branches' stock and an unscoped UPDATE could decrement a same-numbered lot elsewhere.
        int currentTotal = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(SUM(remaining_qty), 0) FROM inventory_lots WHERE sku = @sku AND branch_name = @branch", new { sku, branch }, transaction);
        int delta = dto.NewCount - currentTotal;

        if (delta == 0)
        {
            await transaction.CommitAsync();
            return Results.Ok(new { Message = "No discrepancy." });
        }

        decimal costUsed;

        if (delta > 0)
        {
            // Found more stock than the system expected. Cost the new lot at whatever the
            // caller specified; otherwise fall back to the SKU's most recent cost in this
            // branch (or 0 if none) so the stock isn't recorded as worthless.
            costUsed = dto.UnitCost ?? await db.ExecuteScalarAsync<decimal?>(
                "SELECT unit_cost FROM inventory_lots WHERE sku = @sku AND branch_name = @branch ORDER BY date_received DESC, lot_id DESC LIMIT 1",
                new { sku, branch }, transaction) ?? 0m;

            int nextLotId = await db.ExecuteScalarAsync<int>(
                "SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = @branch", new { branch }, transaction) + 1;

            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                VALUES (@branch, @LotId, @sku, CURRENT_TIMESTAMP, @Qty, @Qty, @UnitCost)",
                new { branch, LotId = nextLotId, sku, Qty = delta, UnitCost = costUsed }, transaction);
        }
        else
        {
            // Shrinkage/damage/miscount: remove stock the same FIFO way a delivery would
            // (oldest lot first, tie-broken by lot_id - see POST /api/deliveries), so the
            // loss is attributed to the oldest-costed stock rather than an arbitrary lot.
            int qtyToRemove = -delta;
            var lots = await db.QueryAsync<LotRow>(@"
                SELECT lot_id AS LotId, remaining_qty AS RemainingQty, unit_cost AS UnitCost
                FROM inventory_lots
                WHERE sku = @sku AND remaining_qty > 0 AND branch_name = @branch
                ORDER BY date_received ASC, lot_id ASC
                FOR UPDATE", new { sku, branch }, transaction);

            decimal totalCostRemoved = 0;
            foreach (var lot in lots)
            {
                if (qtyToRemove <= 0) break;

                int qtyFromThisLot = Math.Min(qtyToRemove, lot.RemainingQty);
                qtyToRemove -= qtyFromThisLot;
                totalCostRemoved += qtyFromThisLot * lot.UnitCost;

                await db.ExecuteAsync(
                    "UPDATE inventory_lots SET remaining_qty = remaining_qty - @Take WHERE lot_id = @LotId AND branch_name = @branch",
                    new { Take = qtyFromThisLot, LotId = lot.LotId, branch }, transaction);
            }

            // qtyToRemove > 0 here would mean the count claims less stock exists than what we
            // just summed as currentTotal, which is a contradiction - can't actually happen.
            costUsed = totalCostRemoved / -delta;
        }

        await db.ExecuteAsync(@"
            INSERT INTO inventory_adjustments (branch_name, sku, date, qty_delta, unit_cost, reason)
            VALUES (@branch, @sku, CURRENT_TIMESTAMP, @Delta, @CostUsed, @Reason)",
            new { branch, sku, Delta = delta, CostUsed = costUsed, dto.Reason }, transaction);

        await transaction.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex)
    {
        await transaction.RollbackAsync();
        return Results.Problem(ex.Message);
    }
});

app.MapGet("/api/inventory/adjustments", async (DateTime start, DateTime end, string? branch) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"
        SELECT a.date AS Date, a.sku AS SKU, i.brand AS Brand, i.base_name AS BaseName,
               a.qty_delta AS QtyDelta, a.unit_cost AS UnitCost, a.reason AS Reason, a.branch_name AS Branch
        FROM inventory_adjustments a LEFT JOIN inventory i ON a.sku = i.sku
        WHERE a.date::date >= @start::date AND a.date::date <= @end::date
          AND (@branch IS NULL OR a.branch_name = @branch)
        ORDER BY a.date DESC";
    return Results.Ok(await db.QueryAsync<InventoryAdjustmentRow>(sql, new { start, end, branch }));
});

// --- RECIPES (baking + decorating share this: a "recipe" just consumes N input SKUs
// and produces one output SKU; a decorating recipe's inputs happen to include a
// BakedGood). Reads are open - branches need the list to know what they can produce.
// Only mutations are owner-gated (see IsOwnerCaller) - the owner alone maintains recipes.

app.MapGet("/api/recipes", async () =>
{
    using var db = new NpgsqlConnection(connectionString);
    var recipes = (await db.QueryAsync<RecipeRow>(@"
        SELECT recipe_id AS RecipeId, name AS Name, kind AS Kind, output_sku AS OutputSku,
               output_qty AS OutputQty, is_active AS IsActive
        FROM recipes WHERE is_active = true ORDER BY name")).ToList();
    var lines = (await db.QueryAsync<RecipeLineRawRow>(
        "SELECT recipe_id AS RecipeId, input_sku AS InputSku, qty AS Qty FROM recipe_lines")).ToList();
    foreach (var r in recipes)
        r.Lines = lines.Where(l => l.RecipeId == r.RecipeId)
            .Select(l => new RecipeLineDto { InputSku = l.InputSku, Qty = l.Qty }).ToList();
    return Results.Ok(recipes);
});

app.MapGet("/api/recipes/{id}", async (int id) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var recipe = await db.QuerySingleOrDefaultAsync<RecipeRow>(@"
        SELECT recipe_id AS RecipeId, name AS Name, kind AS Kind, output_sku AS OutputSku,
               output_qty AS OutputQty, is_active AS IsActive
        FROM recipes WHERE recipe_id = @id", new { id });
    if (recipe == null) return Results.NotFound();

    var lines = await db.QueryAsync<RecipeLineRawRow>(
        "SELECT recipe_id AS RecipeId, input_sku AS InputSku, qty AS Qty FROM recipe_lines WHERE recipe_id = @id", new { id });
    recipe.Lines = lines.Select(l => new RecipeLineDto { InputSku = l.InputSku, Qty = l.Qty }).ToList();
    return Results.Ok(recipe);
});

app.MapPost("/api/recipes", async (RecipeDto dto, HttpContext http) =>
{
    if (!IsOwnerCaller(http)) return Results.Problem("This endpoint is restricted to the owner.", statusCode: 403);
    if (dto.Lines == null || dto.Lines.Count == 0) return Results.BadRequest("A recipe needs at least one input line.");
    var validationError = ValidateRecipeDto(dto);
    if (validationError != null) return Results.BadRequest(validationError);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        int recipeId = await db.ExecuteScalarAsync<int>(@"
            INSERT INTO recipes (name, kind, output_sku, output_qty)
            VALUES (@Name, @Kind, @OutputSku, @OutputQty) RETURNING recipe_id",
            new { dto.Name, dto.Kind, dto.OutputSku, dto.OutputQty }, tx);

        foreach (var line in dto.Lines)
            await db.ExecuteAsync(
                "INSERT INTO recipe_lines (recipe_id, input_sku, qty) VALUES (@recipeId, @InputSku, @Qty)",
                new { recipeId, line.InputSku, line.Qty }, tx);

        await tx.CommitAsync();
        return Results.Ok(new { RecipeId = recipeId });
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapPut("/api/recipes/{id}", async (int id, RecipeDto dto, HttpContext http) =>
{
    if (!IsOwnerCaller(http)) return Results.Problem("This endpoint is restricted to the owner.", statusCode: 403);
    if (dto.Lines == null || dto.Lines.Count == 0) return Results.BadRequest("A recipe needs at least one input line.");
    var validationError = ValidateRecipeDto(dto);
    if (validationError != null) return Results.BadRequest(validationError);

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        int rows = await db.ExecuteAsync(@"
            UPDATE recipes SET name = @Name, kind = @Kind, output_sku = @OutputSku, output_qty = @OutputQty
            WHERE recipe_id = @id", new { id, dto.Name, dto.Kind, dto.OutputSku, dto.OutputQty }, tx);
        if (rows == 0) { await tx.RollbackAsync(); return Results.NotFound(); }

        await db.ExecuteAsync("DELETE FROM recipe_lines WHERE recipe_id = @id", new { id }, tx);
        foreach (var line in dto.Lines)
            await db.ExecuteAsync(
                "INSERT INTO recipe_lines (recipe_id, input_sku, qty) VALUES (@id, @InputSku, @Qty)",
                new { id, line.InputSku, line.Qty }, tx);

        await tx.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapPatch("/api/recipes/{id}/deactivate", async (int id, HttpContext http) =>
{
    if (!IsOwnerCaller(http)) return Results.Problem("This endpoint is restricted to the owner.", statusCode: 403);
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync("UPDATE recipes SET is_active = false WHERE recipe_id = @id", new { id });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// --- PRODUCTION (baking + decorating batches) ---
// Deliberately NOT IP-gated yet: branch PCs aren't on Tailscale, so this is open
// like /api/deliveries/{id}/accept. TODO: bind to a per-branch IP once known.

app.MapPost("/api/production", async (ProductionDto dto) =>
{
    if (string.IsNullOrWhiteSpace(dto.Branch)) return Results.BadRequest("Branch is required.");
    if (string.IsNullOrWhiteSpace(dto.StaffName)) return Results.BadRequest("StaffName is required.");
    // Required so the dedup guard below can make a re-submit idempotent (the client mints one
    // PRD-... id per batch and reuses it across a retry after a lost response).
    if (string.IsNullOrWhiteSpace(dto.TransactionId)) return Results.BadRequest("TransactionId is required.");
    // BatchMultiplier <= 0 used to sail through as a silent no-op batch (0 consumed, 0 credited,
    // still recorded); a negative multiplier was only ever caught incidentally by the
    // chk_remaining_qty_non_negative constraint on inventory_lots, surfacing a raw Postgres
    // error to a caller of this deliberately-un-IP-gated endpoint. Reject both cleanly up front.
    if (dto.BatchMultiplier <= 0) return Results.BadRequest("BatchMultiplier must be greater than zero.");
    if (dto.OutputQty < 0) return Results.BadRequest("OutputQty cannot be negative.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        // Same per-branch serialization as every other FIFO writer (accept/adjust/deliver).
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @Branch))", new { dto.Branch }, tx);

        // Idempotency: if this transaction_id already produced a batch for this branch, a prior
        // submit committed and the client just didn't hear back. Return the existing result rather
        // than FIFO-consuming inputs and crediting output a second time.
        var existingBatch = await db.QuerySingleOrDefaultAsync<ProductionBatchRow>(@"
            SELECT output_sku AS OutputSku, output_qty AS OutputQty, total_input_cost AS TotalInputCost
            FROM production_batches WHERE branch_name = @Branch AND transaction_id = @TransactionId",
            new { dto.Branch, dto.TransactionId }, tx);
        if (existingBatch != null)
        {
            await tx.CommitAsync();
            return Results.Ok(new { existingBatch.OutputSku, existingBatch.OutputQty, existingBatch.TotalInputCost });
        }

        var recipe = await db.QuerySingleOrDefaultAsync<RecipeRow>(@"
            SELECT recipe_id AS RecipeId, name AS Name, kind AS Kind, output_sku AS OutputSku,
                   output_qty AS OutputQty, is_active AS IsActive
            FROM recipes WHERE recipe_id = @RecipeId", new { dto.RecipeId }, tx);
        if (recipe == null) { await tx.RollbackAsync(); return Results.NotFound($"No recipe {dto.RecipeId}."); }

        var lines = (await db.QueryAsync<RecipeLineRawRow>(
            "SELECT recipe_id AS RecipeId, input_sku AS InputSku, qty AS Qty FROM recipe_lines WHERE recipe_id = @RecipeId",
            new { dto.RecipeId }, tx)).ToList();
        if (lines.Count == 0) { await tx.RollbackAsync(); return Results.BadRequest("Recipe has no input lines."); }

        decimal totalInputCost = 0;
        var consumedRows = new List<(string Sku, int Qty, decimal Cost)>();

        foreach (var line in lines)
        {
            // Rounds up so a fractional multiplier never under-consumes an ingredient.
            int qtyNeeded = (int)Math.Ceiling(line.Qty * dto.BatchMultiplier);

            var lots = await db.QueryAsync<LotRow>(@"
                SELECT lot_id AS LotId, remaining_qty AS RemainingQty, unit_cost AS UnitCost
                FROM inventory_lots
                WHERE sku = @sku AND remaining_qty > 0 AND branch_name = @Branch
                ORDER BY date_received ASC, lot_id ASC
                FOR UPDATE", new { sku = line.InputSku, dto.Branch }, tx);

            int remaining = qtyNeeded;
            decimal lineCost = 0;
            foreach (var lot in lots)
            {
                if (remaining <= 0) break;
                int take = Math.Min(remaining, lot.RemainingQty);
                remaining -= take;
                lineCost += take * lot.UnitCost;

                await db.ExecuteAsync(
                    "UPDATE inventory_lots SET remaining_qty = remaining_qty - @Take WHERE lot_id = @LotId AND branch_name = @Branch",
                    new { Take = take, lot.LotId, dto.Branch }, tx);
            }

            if (remaining > 0)
                throw new InsufficientStockException($"Insufficient stock for {line.InputSku}. Short by {remaining}.");

            totalInputCost += lineCost;
            consumedRows.Add((line.InputSku, qtyNeeded, lineCost));
        }

        // OutputQty lets the baker record actual yield (a burnt tray, etc.); 0 means
        // "use the recipe's default yield scaled by the multiplier".
        int outputQty = dto.OutputQty > 0 ? dto.OutputQty : (int)Math.Round(recipe.OutputQty * dto.BatchMultiplier);
        decimal outputUnitCost = outputQty > 0 ? totalInputCost / outputQty : 0;

        int nextLotId = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = @Branch", new { dto.Branch }, tx) + 1;

        await db.ExecuteAsync(@"
            INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
            VALUES (@Branch, @LotId, @OutputSku, CURRENT_TIMESTAMP, @OutputQty, @OutputQty, @UnitCost)",
            new { dto.Branch, LotId = nextLotId, recipe.OutputSku, OutputQty = outputQty, UnitCost = outputUnitCost }, tx);

        int nextLocalId = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(MAX(local_id), 0) FROM production_batches WHERE branch_name = @Branch", new { dto.Branch }, tx) + 1;

        await db.ExecuteAsync(@"
            INSERT INTO production_batches (branch_name, local_id, transaction_id, recipe_id, staff_name, batch_multiplier, output_sku, output_qty, total_input_cost)
            VALUES (@Branch, @LocalId, @TransactionId, @RecipeId, @StaffName, @BatchMultiplier, @OutputSku, @OutputQty, @TotalInputCost)",
            new { dto.Branch, LocalId = nextLocalId, dto.TransactionId, dto.RecipeId, dto.StaffName, dto.BatchMultiplier,
                  recipe.OutputSku, OutputQty = outputQty, TotalInputCost = totalInputCost }, tx);

        foreach (var c in consumedRows)
            await db.ExecuteAsync(@"
                INSERT INTO production_consumed (branch_name, production_local_id, transaction_id, input_sku, qty, cost)
                VALUES (@Branch, @LocalId, @TransactionId, @Sku, @Qty, @Cost)",
                new { dto.Branch, LocalId = nextLocalId, dto.TransactionId, c.Sku, c.Qty, c.Cost }, tx);

        await tx.CommitAsync();
        return Results.Ok(new { OutputSku = recipe.OutputSku, OutputQty = outputQty, TotalInputCost = totalInputCost });
    }
    catch (InsufficientStockException ex) { await tx.RollbackAsync(); return Results.Conflict(ex.Message); }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.MapGet("/api/production", async (string branch, DateTime? start, DateTime? end) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"
        SELECT p.transaction_id AS TransactionId, p.date AS Date, p.recipe_id AS RecipeId, r.name AS RecipeName,
               p.staff_name AS StaffName, p.batch_multiplier AS BatchMultiplier, p.output_sku AS OutputSku,
               p.output_qty AS OutputQty, p.total_input_cost AS TotalInputCost
        FROM production_batches p LEFT JOIN recipes r ON p.recipe_id = r.recipe_id
        WHERE p.branch_name = @branch
          AND (@start::timestamp IS NULL OR p.date >= @start::timestamp)
          AND (@end::timestamp IS NULL OR p.date <= @end::timestamp)
        ORDER BY p.date DESC";
    return Results.Ok(await db.QueryAsync<ProductionBatchRow>(sql, new { branch, start, end }));
});

// POS sale sync: the branch app queues sales in a local SQLite db while offline and pushes
// them here in batches. Idempotent by (branch_name, client_sale_id) - a GUID the POS mints
// at the counter - so retries and double-pushes are the normal path, not an error. Each sale
// gets its own transaction (one bad sale must not block the rest of the batch draining).
// A sale is NEVER rejected for insufficient stock: FIFO consumes what exists and records
// the uncovered remainder as shortfall_qty (oversell is warn-but-allow at the counter,
// because recording production requires connectivity and sales must not stop).
// Deliberately not IP-gated yet, like /accept and /api/production - branch PCs aren't on
// Tailscale; this joins the future branch_name -> ip map when they are.
app.MapPost("/api/sales", async (List<PosSaleDto> sales) =>
{
    var results = new List<PosSaleSyncResult>();

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();

    foreach (var sale in sales)
    {
        // Cheap validation first, before touching the db at all.
        string? invalid = null;
        if (string.IsNullOrWhiteSpace(sale.ClientSaleId)) invalid = "ClientSaleId is required.";
        else if (string.IsNullOrWhiteSpace(sale.Branch)) invalid = "Branch is required.";
        else if (string.IsNullOrWhiteSpace(sale.StaffName)) invalid = "StaffName is required.";
        else if (sale.Lines == null || sale.Lines.Count == 0) invalid = "A sale needs at least one line.";
        else if (sale.TotalAmount < 0) invalid = "Sale total cannot be negative.";
        else if (sale.Lines.Any(l => l.SKU != null && l.Qty <= 0)) invalid = "Product line Qty must be greater than zero.";
        else if (sale.Lines.Any(l => l.SKU == null && l.LineTotal > 0)) invalid = "Discount lines (no SKU) cannot be positive.";
        // Defense-in-depth against client-side money drift (e.g. a mis-stored local total):
        // the server is the one place that can catch a mismatch before it's committed.
        else if (Math.Abs(sale.Lines.Sum(l => l.LineTotal) - sale.TotalAmount) > 0.01m)
            invalid = "Sale total does not match the sum of its lines.";

        if (invalid != null)
        {
            results.Add(new PosSaleSyncResult { ClientSaleId = sale.ClientSaleId, Status = "Rejected", Detail = invalid });
            continue;
        }

        using var tx = await db.BeginTransactionAsync();
        try
        {
            // Same per-branch serialization as every other FIFO writer (accept/adjust/deliver/produce).
            await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @Branch))", new { sale.Branch }, tx);

            int already = await db.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM pos_sales WHERE branch_name = @Branch AND client_sale_id = @ClientSaleId",
                new { sale.Branch, sale.ClientSaleId }, tx);
            if (already > 0)
            {
                await tx.RollbackAsync();
                results.Add(new PosSaleSyncResult { ClientSaleId = sale.ClientSaleId, Status = "AlreadySynced", Detail = "" });
                continue;
            }

            // Every product line must reference a real, active SKU - the POS catalog cache
            // should make this impossible, so a miss means a stale/hand-built payload.
            foreach (var line in sale.Lines.Where(l => l.SKU != null))
            {
                int known = await db.ExecuteScalarAsync<int>(
                    "SELECT COUNT(*) FROM inventory WHERE sku = @SKU AND is_active = true", new { line.SKU }, tx);
                if (known == 0) throw new Exception($"Unknown or inactive SKU '{line.SKU}'.");
            }

            int nextLocalId = await db.ExecuteScalarAsync<int>(
                "SELECT COALESCE(MAX(local_id), 0) FROM pos_sales WHERE branch_name = @Branch", new { sale.Branch }, tx) + 1;

            await db.ExecuteAsync(@"
                INSERT INTO pos_sales (branch_name, local_id, client_sale_id, staff_name, sold_at, total_amount)
                VALUES (@Branch, @LocalId, @ClientSaleId, @StaffName, @SoldAt, @TotalAmount)",
                new { sale.Branch, LocalId = nextLocalId, sale.ClientSaleId, sale.StaffName, sale.SoldAt, sale.TotalAmount }, tx);

            int totalShortfall = 0;
            foreach (var line in sale.Lines)
            {
                int shortfall = 0;
                decimal consumedCost = 0;

                if (line.SKU != null)
                {
                    // FIFO-consume from the branch's own lots; unlike production, a shortage
                    // doesn't throw - the uncovered remainder is recorded on the line.
                    var lots = await db.QueryAsync<LotRow>(@"
                        SELECT lot_id AS LotId, remaining_qty AS RemainingQty, unit_cost AS UnitCost
                        FROM inventory_lots
                        WHERE sku = @SKU AND remaining_qty > 0 AND branch_name = @Branch
                        ORDER BY date_received ASC, lot_id ASC
                        FOR UPDATE", new { line.SKU, sale.Branch }, tx);

                    int remaining = line.Qty;
                    foreach (var lot in lots)
                    {
                        if (remaining <= 0) break;
                        int take = Math.Min(remaining, lot.RemainingQty);
                        remaining -= take;
                        consumedCost += take * lot.UnitCost;

                        await db.ExecuteAsync(
                            "UPDATE inventory_lots SET remaining_qty = remaining_qty - @Take WHERE lot_id = @LotId AND branch_name = @Branch",
                            new { Take = take, lot.LotId, sale.Branch }, tx);
                    }

                    shortfall = remaining;
                    totalShortfall += shortfall;
                }

                await db.ExecuteAsync(@"
                    INSERT INTO pos_sale_lines (branch_name, client_sale_id, sku, description, qty, unit_price, line_total, shortfall_qty, consumed_cost)
                    VALUES (@Branch, @ClientSaleId, @SKU, @Description, @Qty, @UnitPrice, @LineTotal, @Shortfall, @ConsumedCost)",
                    new { sale.Branch, sale.ClientSaleId, line.SKU, line.Description, line.Qty, line.UnitPrice, line.LineTotal,
                          Shortfall = shortfall, ConsumedCost = consumedCost }, tx);
            }

            await tx.CommitAsync();
            results.Add(new PosSaleSyncResult
            {
                ClientSaleId = sale.ClientSaleId,
                Status = totalShortfall > 0 ? "SyncedWithShortfall" : "Synced",
                Detail = totalShortfall > 0 ? $"Stock short by {totalShortfall} across the sale - record baking/decorating." : ""
            });
        }
        catch (PostgresException ex) when (ex.SqlState == "23505")
        {
            // Two clients raced the same client_sale_id past the COUNT check; the UNIQUE
            // constraint is the backstop and the sale is safely on the server already.
            await tx.RollbackAsync();
            results.Add(new PosSaleSyncResult { ClientSaleId = sale.ClientSaleId, Status = "AlreadySynced", Detail = "" });
        }
        catch (Exception ex)
        {
            await tx.RollbackAsync();
            results.Add(new PosSaleSyncResult { ClientSaleId = sale.ClientSaleId, Status = "Rejected", Detail = ex.Message });
        }
    }

    return Results.Ok(results);
});

// Sales history for the office's Branch Sales Report. start/end are required (not
// DateTime?) to sidestep the Npgsql nullable-DateTime type-inference bug documented
// on /api/production above.
app.MapGet("/api/sales", async (string branch, DateTime start, DateTime end) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"
        SELECT s.local_id AS LocalId, s.client_sale_id AS ClientSaleId, s.staff_name AS StaffName,
               s.sold_at AS SoldAt, s.total_amount AS TotalAmount, s.voided AS Voided,
               COALESCE((SELECT SUM(l.shortfall_qty) FROM pos_sale_lines l
                         WHERE l.branch_name = s.branch_name AND l.client_sale_id = s.client_sale_id), 0) > 0 AS HasShortfall
        FROM pos_sales s
        WHERE s.branch_name = @branch AND s.sold_at >= @start AND s.sold_at <= @end
        ORDER BY s.sold_at DESC";
    return Results.Ok(await db.QueryAsync<PosSaleSummaryRow>(sql, new { branch, start, end }));
});

app.MapGet("/api/sales/{branch}/{clientSaleId}", async (string branch, string clientSaleId) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var lines = (await db.QueryAsync<PosSaleLineRow>(@"
        SELECT sku AS SKU, description AS Description, qty AS Qty, unit_price AS UnitPrice,
               line_total AS LineTotal, shortfall_qty AS ShortfallQty
        FROM pos_sale_lines
        WHERE branch_name = @branch AND client_sale_id = @clientSaleId
        ORDER BY id ASC", new { branch, clientSaleId })).ToList();
    return lines.Count == 0 ? Results.NotFound() : Results.Ok(lines);
});

// Void a completed sale. Reverses its inventory effect by restocking exactly what FIFO actually
// consumed (qty - shortfall_qty, valued at the recorded consumed_cost) and flags the sale as voided.
// Idempotent: re-voiding is a harmless no-op, so a retry after a lost response is safe. Online-only
// - the sale must have synced first (same connectivity posture as accept/production). Discount lines
// (sku NULL) and fully-shortfall lines restock nothing. Not IP-gated, like the other branch writes.
app.MapPost("/api/sales/{branch}/{clientSaleId}/void", async (string branch, string clientSaleId, VoidSaleDto dto) =>
{
    if (string.IsNullOrWhiteSpace(dto.VoidedBy)) return Results.BadRequest("VoidedBy is required.");

    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var tx = await db.BeginTransactionAsync();
    try
    {
        // Serialize with every other FIFO writer on this branch before touching lot ids.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:' || @branch))", new { branch }, tx);

        // Lock the sale header so two concurrent voids serialize instead of both restocking.
        var sale = await db.QuerySingleOrDefaultAsync(
            "SELECT voided FROM pos_sales WHERE branch_name = @branch AND client_sale_id = @clientSaleId FOR UPDATE",
            new { branch, clientSaleId }, tx);
        if (sale == null) { await tx.RollbackAsync(); return Results.NotFound($"No sale {clientSaleId} for {branch}."); }
        if ((bool)sale.voided)
        {
            await tx.CommitAsync();
            return Results.Ok(new { Status = "AlreadyVoided" });
        }

        // Raw column names (no aliases) so the dynamic overload's case-sensitive member lookup
        // matches Postgres's lowercase columns - same idiom as DELETE /api/deliveries.
        var saleLines = await db.QueryAsync(
            "SELECT sku, qty, shortfall_qty, consumed_cost FROM pos_sale_lines WHERE branch_name = @branch AND client_sale_id = @clientSaleId",
            new { branch, clientSaleId }, tx);

        int nextLotId = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = @branch", new { branch }, tx);

        foreach (var line in saleLines)
        {
            if (line.sku == null) continue;                          // discount line - no inventory effect
            int consumedQty = (int)line.qty - (int)line.shortfall_qty; // what FIFO actually deducted
            if (consumedQty <= 0) continue;                          // fully shortfall - nothing to return
            decimal unitCost = (decimal)line.consumed_cost / consumedQty;
            nextLotId++;
            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                VALUES (@branch, @LotId, @sku, CURRENT_TIMESTAMP, @Qty, @Qty, @UnitCost)",
                new { branch, LotId = nextLotId, sku = (string)line.sku, Qty = consumedQty, UnitCost = unitCost }, tx);
        }

        await db.ExecuteAsync(@"
            UPDATE pos_sales SET voided = TRUE, voided_at = CURRENT_TIMESTAMP, voided_by = @VoidedBy
            WHERE branch_name = @branch AND client_sale_id = @clientSaleId",
            new { dto.VoidedBy, branch, clientSaleId }, tx);

        await tx.CommitAsync();
        return Results.Ok(new { Status = "Voided" });
    }
    catch (Exception ex) { await tx.RollbackAsync(); return Results.Problem(ex.Message); }
});

app.Run();

// DTO Schemas matching the SQLite structures

public class ClassifyInventoryDto
{
    public string Category { get; set; } = "RawMaterial";
    public string? Uom { get; set; }
    public decimal PackMultiplier { get; set; } = 1.0m;
}

public class RecipeLineDto
{
    public string InputSku { get; set; } = string.Empty;
    public int Qty { get; set; }
}

public class RecipeLineRawRow
{
    public int RecipeId { get; set; }
    public string InputSku { get; set; } = string.Empty;
    public int Qty { get; set; }
}

public class RecipeDto
{
    public string Name { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty; // "Baking" or "Decorating"
    public string OutputSku { get; set; } = string.Empty;
    public int OutputQty { get; set; }
    public List<RecipeLineDto> Lines { get; set; } = new();
}

public class RecipeRow
{
    public int RecipeId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
    public string OutputSku { get; set; } = string.Empty;
    public int OutputQty { get; set; }
    public bool IsActive { get; set; }
    public List<RecipeLineDto> Lines { get; set; } = new();
}

// Thrown for a FIFO shortfall so the catch block can return a clean 409 instead of a raw 500
// (see bug-track.md's "POST /api/production returns a raw 500..." entry).
public class InsufficientStockException : Exception
{
    public InsufficientStockException(string message) : base(message) { }
}

public class ProductionDto
{
    public string Branch { get; set; } = string.Empty;
    public int RecipeId { get; set; }
    public string StaffName { get; set; } = string.Empty;
    public decimal BatchMultiplier { get; set; } = 1;
    public int OutputQty { get; set; } // 0 = use the recipe's default yield * BatchMultiplier
    public string TransactionId { get; set; } = string.Empty;
}

public class ProductionBatchRow
{
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public int RecipeId { get; set; }
    public string RecipeName { get; set; } = string.Empty;
    public string StaffName { get; set; } = string.Empty;
    public decimal BatchMultiplier { get; set; }
    public string OutputSku { get; set; } = string.Empty;
    public int OutputQty { get; set; }
    public decimal TotalInputCost { get; set; }
}

public class InventoryItemDto
{
    public string SKU { get; set; } = string.Empty;
    public string Brand { get; set; } = string.Empty;
    public string BaseName { get; set; } = string.Empty;
    public decimal Price { get; set; }
    public bool IsActive { get; set; }
}

public class SetPriceDto
{
    public decimal Price { get; set; }
}

public class PosSaleLineDto
{
    public string? SKU { get; set; } // null = discount line (no inventory effect)
    public string Description { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal LineTotal { get; set; }
}

public class PosSaleDto
{
    public string ClientSaleId { get; set; } = string.Empty; // GUID minted offline by the POS
    public string Branch { get; set; } = string.Empty;
    public string StaffName { get; set; } = string.Empty;
    public DateTime SoldAt { get; set; } // counter time, not sync time
    public decimal TotalAmount { get; set; }
    public List<PosSaleLineDto> Lines { get; set; } = new();
}

public class PosSaleSyncResult
{
    public string ClientSaleId { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty; // Synced | AlreadySynced | SyncedWithShortfall | Rejected
    public string Detail { get; set; } = string.Empty;
}

public class PosSaleSummaryRow
{
    public int LocalId { get; set; }
    public string ClientSaleId { get; set; } = string.Empty;
    public string StaffName { get; set; } = string.Empty;
    public DateTime SoldAt { get; set; }
    public decimal TotalAmount { get; set; }
    public bool HasShortfall { get; set; }
    public bool Voided { get; set; }
}

public class VoidSaleDto
{
    public string VoidedBy { get; set; } = string.Empty;
}

public class PosSaleLineRow
{
    public string? SKU { get; set; }
    public string Description { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal LineTotal { get; set; }
    public int ShortfallQty { get; set; }
}

public class PurchaseLogDto
{
    public int Id { get; set; }
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string SKU { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitCost { get; set; }
    public string Supplier { get; set; } = string.Empty;
}

public class LotRow
{
    public int LotId { get; set; }
    public int RemainingQty { get; set; }
    public decimal UnitCost { get; set; }
}

public class UpdateProductDto
{
    public string Brand { get; set; } = string.Empty;
    public string BaseName { get; set; } = string.Empty;
}

public class AdjustInventoryDto
{
    public int NewCount { get; set; }
    public decimal? UnitCost { get; set; }
    public string Reason { get; set; } = string.Empty;
    public string Branch { get; set; } = "Office";
}

public class InventoryAdjustmentRow
{
    public DateTime Date { get; set; }
    public string SKU { get; set; } = string.Empty;
    public string Brand { get; set; } = string.Empty;
    public string BaseName { get; set; } = string.Empty;
    public int QtyDelta { get; set; }
    public decimal UnitCost { get; set; }
    public string Reason { get; set; } = string.Empty;
    public string Branch { get; set; } = string.Empty;
}

public class DeliveryLogDto
{
    public int Id { get; set; }
    public string TransactionId { get; set; } = string.Empty;
    public string Date { get; set; } = string.Empty;
    public string SKU { get; set; } = string.Empty;
    public int Qty { get; set; }
    public string ToBranch { get; set; } = string.Empty;
    public decimal TotalLineCost { get; set; }
    public string Requester { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
}

public class InventoryLotDto
{
    public int LotId { get; set; }
    public string SKU { get; set; } = string.Empty;
    public string DateReceived { get; set; } = string.Empty;
    public int OriginalQty { get; set; }
    public int RemainingQty { get; set; }
    public decimal UnitCost { get; set; }
}

public class SyncResponse
{
    public bool Success { get; set; }
    public List<string> SyncedInventorySKUs { get; set; } = new();
    public List<int> SyncedPurchaseIds { get; set; } = new();
    public List<int> SyncedDeliveryIds { get; set; } = new();
    public List<int> SyncedLotIds { get; set; } = new();
}

public class PurchaseTicketSummary
{
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string Supplier { get; set; } = string.Empty;
    public decimal TotalAmount { get; set; }
}

public class PurchaseLog
{
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string SKU { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal UnitCost { get; set; }
    public string Supplier { get; set; } = string.Empty;
}

public class DeliveryTicketSummary
{
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string ToBranch { get; set; } = string.Empty;
    public int TotalItems { get; set; }
    public string Requester { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public decimal TotalCost { get; set; }
    public string Status { get; set; } = string.Empty;
}

public class AcceptDeliveryDto
{
    public string Branch { get; set; } = string.Empty;
    public string AcceptedBy { get; set; } = string.Empty;
}

public class DeliveryLog
{
    public string TransactionId { get; set; } = string.Empty;
    public DateTime Date { get; set; }
    public string SKU { get; set; } = string.Empty;
    public int Qty { get; set; }
    public string ToBranch { get; set; } = string.Empty;
    public decimal TotalLineCost { get; set; }
    public string Requester { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
}

public class DailyDeliveryPrintItem
{
    public string TransactionId { get; set; } = string.Empty;
    public string ToBranch { get; set; } = string.Empty;
    public string Requester { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public string SKU { get; set; } = string.Empty;
    public string BaseName { get; set; } = string.Empty;
    public string Brand { get; set; } = string.Empty;
    public int Qty { get; set; }
    public decimal TotalLineCost { get; set; }
}
