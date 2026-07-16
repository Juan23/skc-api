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

// Endpoints
app.MapGet("/health", () => Results.Ok(new { Status = "Healthy" }));

app.MapPost("/api/purchases", async (List<PurchaseLogDto> purchases) =>
{
    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var transaction = await db.BeginTransactionAsync();

    try
    {
        // Serialize concurrent writers on this branch so the MAX()+1 ID assignment below can't race.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: transaction);

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
app.MapPost("/api/deliveries", async (List<DeliveryLogDto> deliveries) =>
{
    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var transaction = await db.BeginTransactionAsync();

    try
    {
        // Serialize concurrent writers on this branch: protects the MAX()+1 ID assignment below,
        // and also stops two concurrent deliveries from both reading the same lot's remaining_qty
        // before either commits (see the FOR UPDATE on the lot query below for the same reason).
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: transaction);

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
            var lots = await db.QueryAsync<LotRow>(@"
                SELECT lot_id AS LotId, remaining_qty AS RemainingQty, unit_cost AS UnitCost
                FROM inventory_lots
                WHERE sku = @SKU AND remaining_qty > 0
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
                    WHERE lot_id = @LotId",
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

app.MapDelete("/api/purchases/{id}", async (string id) => {
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
    var sql = @"SELECT transaction_id AS TransactionId, date AS Date, to_branch AS ToBranch, SUM(qty) AS TotalItems,
                       MAX(requester) AS Requester, MAX(reason) AS Reason, SUM(total_line_cost) AS TotalCost,
                       MIN(status) AS Status
                FROM delivery_logs WHERE date >= @start AND date <= @end GROUP BY transaction_id, date, to_branch ORDER BY date DESC";
    return Results.Ok(await db.QueryAsync<DeliveryTicketSummary>(sql, new { start, end }));
});

app.MapGet("/api/deliveries/{id}", async (string id) => {
    using var db = new NpgsqlConnection(connectionString);
    return Results.Ok(await db.QueryAsync<DeliveryLog>("SELECT transaction_id AS TransactionId, date AS Date, sku AS SKU, qty AS Qty, to_branch AS ToBranch, total_line_cost AS TotalLineCost, requester AS Requester, reason AS Reason FROM delivery_logs WHERE transaction_id = @id", new { id }));
});

app.MapDelete("/api/deliveries/{id}", async (string id) => {
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
            "SELECT to_branch, status FROM delivery_logs WHERE transaction_id = @transactionId FOR UPDATE",
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
    var products = await db.QueryAsync(@"
        SELECT 
            i.sku AS SKU, 
            i.brand AS Brand, 
            i.base_name AS BaseName, 
            i.price AS Price,
            COALESCE((SELECT SUM(remaining_qty) FROM inventory_lots l WHERE l.sku = i.sku), 0) AS CurrentStock
        FROM inventory i 
        WHERE i.is_active = true");
    return Results.Ok(products);
});

app.MapPost("/api/inventory", async (InventoryItemDto product) =>
{
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

app.MapPut("/api/inventory/{sku}", async (string sku, UpdateProductDto dto) =>
{
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(
        "UPDATE inventory SET brand = @Brand, base_name = @BaseName, last_updated = CURRENT_TIMESTAMP WHERE sku = @sku",
        new { dto.Brand, dto.BaseName, sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

app.MapPatch("/api/inventory/{sku}/deactivate", async (string sku) =>
{
    using var db = new NpgsqlConnection(connectionString);
    int rows = await db.ExecuteAsync(
        "UPDATE inventory SET is_active = false, last_updated = CURRENT_TIMESTAMP WHERE sku = @sku", new { sku });
    return rows == 0 ? Results.NotFound() : Results.Ok();
});

// Reconciles the system's stock with a physical count. Used when a manual inventory
// count (see the client's "print all inventory" count sheet) finds a discrepancy.
app.MapPost("/api/inventory/{sku}/adjust", async (string sku, AdjustInventoryDto dto) =>
{
    using var db = new NpgsqlConnection(connectionString);
    await db.OpenAsync();
    using var transaction = await db.BeginTransactionAsync();

    try
    {
        // Serialize concurrent writers on this branch: protects the MAX()+1 lot ID assignment below,
        // and (together with the FOR UPDATE in the shrinkage branch) stops a concurrent delivery or
        // adjustment from reading the same lot's remaining_qty before either commits.
        await db.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext('inventory-write:Office'))", transaction: transaction);

        int currentTotal = await db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(SUM(remaining_qty), 0) FROM inventory_lots WHERE sku = @sku", new { sku }, transaction);
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
            // caller specified; otherwise fall back to the SKU's most recent purchase cost
            // (or 0 if it's never been purchased) so the stock isn't recorded as worthless.
            costUsed = dto.UnitCost ?? await db.ExecuteScalarAsync<decimal?>(
                "SELECT unit_cost FROM inventory_lots WHERE sku = @sku ORDER BY date_received DESC, lot_id DESC LIMIT 1",
                new { sku }, transaction) ?? 0m;

            int nextLotId = await db.ExecuteScalarAsync<int>(
                "SELECT COALESCE(MAX(lot_id), 0) FROM inventory_lots WHERE branch_name = 'Office'", transaction) + 1;

            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                VALUES ('Office', @LotId, @sku, CURRENT_TIMESTAMP, @Qty, @Qty, @UnitCost)",
                new { LotId = nextLotId, sku, Qty = delta, UnitCost = costUsed }, transaction);
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
                WHERE sku = @sku AND remaining_qty > 0
                ORDER BY date_received ASC, lot_id ASC
                FOR UPDATE", new { sku }, transaction);

            decimal totalCostRemoved = 0;
            foreach (var lot in lots)
            {
                if (qtyToRemove <= 0) break;

                int qtyFromThisLot = Math.Min(qtyToRemove, lot.RemainingQty);
                qtyToRemove -= qtyFromThisLot;
                totalCostRemoved += qtyFromThisLot * lot.UnitCost;

                await db.ExecuteAsync(
                    "UPDATE inventory_lots SET remaining_qty = remaining_qty - @Take WHERE lot_id = @LotId",
                    new { Take = qtyFromThisLot, LotId = lot.LotId }, transaction);
            }

            // qtyToRemove > 0 here would mean the count claims less stock exists than what we
            // just summed as currentTotal, which is a contradiction - can't actually happen.
            costUsed = totalCostRemoved / -delta;
        }

        await db.ExecuteAsync(@"
            INSERT INTO inventory_adjustments (branch_name, sku, date, qty_delta, unit_cost, reason)
            VALUES ('Office', @sku, CURRENT_TIMESTAMP, @Delta, @CostUsed, @Reason)",
            new { sku, Delta = delta, CostUsed = costUsed, dto.Reason }, transaction);

        await transaction.CommitAsync();
        return Results.Ok();
    }
    catch (Exception ex)
    {
        await transaction.RollbackAsync();
        return Results.Problem(ex.Message);
    }
});

app.MapGet("/api/inventory/adjustments", async (DateTime start, DateTime end) =>
{
    using var db = new NpgsqlConnection(connectionString);
    var sql = @"
        SELECT a.date AS Date, a.sku AS SKU, i.brand AS Brand, i.base_name AS BaseName,
               a.qty_delta AS QtyDelta, a.unit_cost AS UnitCost, a.reason AS Reason
        FROM inventory_adjustments a LEFT JOIN inventory i ON a.sku = i.sku
        WHERE a.date >= @start AND a.date <= @end
        ORDER BY a.date DESC";
    return Results.Ok(await db.QueryAsync<InventoryAdjustmentRow>(sql, new { start, end }));
});

app.Run();

// DTO Schemas matching the SQLite structures

public class InventoryItemDto
{
    public string SKU { get; set; } = string.Empty;
    public string Brand { get; set; } = string.Empty;
    public string BaseName { get; set; } = string.Empty;
    public decimal Price { get; set; }
    public bool IsActive { get; set; }
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
