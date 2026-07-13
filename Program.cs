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

app.MapGet("/api/inventory", async () =>
{
    using var db = new NpgsqlConnection(connectionString);
    var products = await db.QueryAsync(@"
        SELECT sku AS SKU, brand AS Brand, base_name AS BaseName, price AS Price 
        FROM inventory 
        WHERE is_active = true");
    return Results.Ok(products);
});

app.MapPost("/api/sync/master", async (HttpContext context) =>
{
    try
    {
        var payload = await context.Request.ReadFromJsonAsync<MasterSyncPayload>();
        if (payload == null || string.IsNullOrWhiteSpace(payload.BranchName))
        {
            return Results.BadRequest("Invalid payload: BranchName is required.");
        }

        using (var db = new NpgsqlConnection(connectionString))
        {
            await db.OpenAsync();
            using (var transaction = await db.BeginTransactionAsync())
            {
                try
                {
                    // 1. Process Inventory (Global Master Catalog Updates)
                    if (payload.Inventory != null && payload.Inventory.Any())
                    {
                        string invSql = @"
                            INSERT INTO inventory (sku, brand, base_name, price, is_active)
                            VALUES (@SKU, @Brand, @BaseName, @Price, @IsActive)
                            ON CONFLICT (sku) DO UPDATE 
                            SET brand = EXCLUDED.brand, 
                                base_name = EXCLUDED.base_name, 
                                price = EXCLUDED.price, 
                                is_active = EXCLUDED.is_active,
                                last_updated = CURRENT_TIMESTAMP";

                        await db.ExecuteAsync(invSql, payload.Inventory, transaction);
                    }

                    // 2. Process Purchase Logs (Immutable)
                    if (payload.Purchases != null && payload.Purchases.Any())
                    {
                        string purSql = @"
                            INSERT INTO purchase_logs (branch_name, local_id, transaction_id, date, sku, qty, unit_cost, supplier)
                            VALUES (@BranchName, @Id, @TransactionId, @Date, @SKU, @Qty, @UnitCost, @Supplier)
                            ON CONFLICT (branch_name, local_id) DO NOTHING";

                        var purParams = payload.Purchases.Select(p => new
                        {
                            BranchName = payload.BranchName,
                            p.Id,
                            p.TransactionId,
                            p.Date,
                            p.SKU,
                            p.Qty,
                            p.UnitCost,
                            p.Supplier
                        }).ToList();

                        await db.ExecuteAsync(purSql, purParams, transaction);
                    }

                    // 3. Process Delivery Logs (Immutable)
                    if (payload.Deliveries != null && payload.Deliveries.Any())
                    {
                        string delSql = @"
                            INSERT INTO delivery_logs (branch_name, local_id, transaction_id, date, sku, qty, to_branch, total_line_cost, requester, reason)
                            VALUES (@BranchName, @Id, @TransactionId, CAST(@Date AS TIMESTAMP), @SKU, @Qty, @ToBranch, @TotalLineCost, @Requester, @Reason)
                            ON CONFLICT (branch_name, local_id) DO NOTHING";

                        var delParams = payload.Deliveries.Select(d => new
                        {
                            BranchName = payload.BranchName,
                            d.Id,
                            d.TransactionId,
                            d.Date,
                            d.SKU,
                            d.Qty,
                            d.ToBranch,
                            d.TotalLineCost,
                            d.Requester,
                            d.Reason
                        }).ToList();

                        await db.ExecuteAsync(delSql, delParams, transaction);
                    }

                    // 4. Process Inventory Lots (Mutable FIFO tracking)
                    if (payload.InventoryLots != null && payload.InventoryLots.Any())
                    {
                        string lotSql = @"
                            INSERT INTO inventory_lots (branch_name, local_lot_id, sku, date_received, original_qty, remaining_qty, unit_cost)
                            VALUES (@BranchName, @LotId, @SKU, CAST(@DateReceived AS TIMESTAMP), @OriginalQty, @RemainingQty, @UnitCost)
                            ON CONFLICT (branch_name, local_lot_id) 
                            DO UPDATE SET remaining_qty = EXCLUDED.remaining_qty";

                        var lotParams = payload.InventoryLots.Select(l => new
                        {
                            BranchName = payload.BranchName,
                            l.LotId,
                            l.SKU,
                            l.DateReceived,
                            l.OriginalQty,
                            l.RemainingQty,
                            l.UnitCost
                        }).ToList();

                        await db.ExecuteAsync(lotSql, lotParams, transaction);
                    }

                    await transaction.CommitAsync();
                }
                catch (Exception ex)
                {
                    await transaction.RollbackAsync();
                    throw new Exception($"Transaction execution failed: {ex.Message}", ex);
                }
            }
        }

        // Return the exact tracked local database IDs back to the terminal so it knows what was committed
        return Results.Ok(new SyncResponse
        {
            Success = true,
            SyncedInventorySKUs = payload.Inventory?.Select(x => x.SKU).ToList() ?? new(),
            SyncedPurchaseIds = payload.Purchases?.Select(x => x.Id).ToList() ?? new(),
            SyncedDeliveryIds = payload.Deliveries?.Select(x => x.Id).ToList() ?? new(),
            SyncedLotIds = payload.InventoryLots?.Select(x => x.LotId).ToList() ?? new()
        });
    }
    catch (Exception ex)
    {
        return Results.Problem($"Master sync processing failed: {ex.Message}");
    }
});

app.Run();

// DTO Schemas matching the SQLite structures
public class MasterSyncPayload
{
    public string BranchName { get; set; } = string.Empty;
    public List<InventoryItemDto> Inventory { get; set; } = new();
    public List<PurchaseLogDto> Purchases { get; set; } = new();
    public List<DeliveryLogDto> Deliveries { get; set; } = new();
    public List<InventoryLotDto> InventoryLots { get; set; } = new();
}

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
