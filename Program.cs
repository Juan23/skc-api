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
        foreach (var p in purchases)
        {
            // 1. Record the purchase (Inject 'Office' to bypass the old DB constraint)
            await db.ExecuteAsync(@"
                INSERT INTO purchase_logs (branch_name, transaction_id, date, sku, qty, unit_cost, supplier)
                VALUES ('Office', @TransactionId, @Date, @SKU, @Qty, @UnitCost, @Supplier)", p, transaction);

            // 2. Create a new inventory lot for FIFO tracking (Inject 'Office' here too)
            await db.ExecuteAsync(@"
                INSERT INTO inventory_lots (branch_name, sku, date_received, original_qty, remaining_qty, unit_cost)
                VALUES ('Office', @SKU, @Date, @Qty, @Qty, @UnitCost)",
                new { p.SKU, p.Date, p.Qty, p.UnitCost }, transaction);
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
        foreach (var d in deliveries)
        {
            int qtyNeeded = d.Qty;

            // FIFO Logic: Fetch oldest available lots first
            var lots = await db.QueryAsync(@"
                SELECT lot_id AS LotId, remaining_qty AS RemainingQty 
                FROM inventory_lots 
                WHERE sku = @SKU AND remaining_qty > 0 
                ORDER BY date_received ASC", new { d.SKU }, transaction);

            foreach (var lot in lots)
            {
                if (qtyNeeded <= 0) break;

                int qtyToTake = Math.Min(qtyNeeded, (int)lot.RemainingQty);
                qtyNeeded -= qtyToTake;

                await db.ExecuteAsync(@"
                    UPDATE inventory_lots 
                    SET remaining_qty = remaining_qty - @Take 
                    WHERE lot_id = @LotId",
                    new { Take = qtyToTake, LotId = lot.LotId }, transaction);
            }

            if (qtyNeeded > 0)
                throw new Exception($"Insufficient inventory for SKU: {d.SKU}. Short by {qtyNeeded}.");

            // Record the delivery
            await db.ExecuteAsync(@"
                INSERT INTO delivery_logs (transaction_id, date, sku, qty, to_branch, total_line_cost, requester, reason)
                VALUES (@TransactionId, CAST(@Date AS TIMESTAMP), @SKU, @Qty, @ToBranch, @TotalLineCost, @Requester, @Reason)",
                d, transaction);
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
            int consumed = await db.ExecuteScalarAsync<int>(
                "SELECT COALESCE(SUM(original_qty - remaining_qty), 0) FROM inventory_lots WHERE sku = @sku AND original_qty = @qty AND unit_cost = @cost",
                new { sku = line.sku, qty = line.qty, cost = line.unit_cost }, tx);
            if (consumed > 0) throw new Exception($"Cannot delete ticket: {line.sku} has already been used in deliveries.");

            await db.ExecuteAsync("DELETE FROM inventory_lots WHERE sku = @sku AND original_qty = @qty AND unit_cost = @cost", new { sku = line.sku, qty = line.qty, cost = line.unit_cost }, tx);
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
                       MAX(requester) AS Requester, MAX(reason) AS Reason, SUM(total_line_cost) AS TotalCost 
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
        var lines = await db.QueryAsync("SELECT sku, qty, total_line_cost FROM delivery_logs WHERE transaction_id = @id", new { id }, tx);
        foreach (var item in lines)
        {
            if (item.qty > 0)
            {
                decimal unitCost = item.total_line_cost / item.qty;
                await db.ExecuteAsync(@"INSERT INTO inventory_lots (sku, date_received, original_qty, remaining_qty, unit_cost) 
                                        VALUES (@sku, CURRENT_TIMESTAMP, @qty, @qty, @cost)",
                                        new { sku = item.sku, qty = item.qty, cost = unitCost }, tx);
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


app.MapGet("/api/inventory", async () =>
{
    using var db = new NpgsqlConnection(connectionString);
    var products = await db.QueryAsync(@"
        SELECT sku AS SKU, brand AS Brand, base_name AS BaseName, price AS Price 
        FROM inventory 
        WHERE is_active = true");
    return Results.Ok(products);
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
