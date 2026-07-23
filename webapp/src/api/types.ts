// TypeScript mirrors of the API's wire DTOs, all captured from real curl output
// rather than transcribed from the C# classes - because the two disagree.
//
// Most endpoints use Dapper's TYPED overload, so rows come back as real C#
// objects and System.Text.Json camelCases them: `TransactionId` -> transactionId.
//
// But /api/inventory and /api/inventory/branch/{branch} use the DYNAMIC overload.
// Those rows are DapperRow bags whose keys are the raw Postgres column names, and
// Postgres folds unquoted aliases to lowercase - so `AS BaseName` arrives as
// `basename`, not `baseName`, and there is no camelCasing to fix it. That is why
// InventoryRow below is all-lowercase while everything else is camelCase. It
// looks like a typo; it is not. Verify with curl before changing it.

export type Role = 'Owner' | 'Office' | 'Branch'

export interface CurrentUser {
  username: string
  role: Role
  branchName: string | null
  mustChangePassword: boolean
}

export interface SetupNeeded {
  needed: boolean
}

export interface AppUser {
  userId: number
  username: string
  role: Role
  branchName: string | null
  isActive: boolean
  mustChangePassword: boolean
  // Rendered as text, never parsed into a JS Date: the DB stores
  // `timestamp without time zone` whose meaning is mixed across the schema
  // (client-sent values are PH local, server CURRENT_TIMESTAMP values are UTC),
  // so a Date round-trip would silently shift some of them.
  createdAt: string
}

// --- inventory (DYNAMIC Dapper overload - lowercase keys, see header note) ---

export interface InventoryRow {
  sku: string
  brand: string | null
  basename: string
  price: number
  category: 'RawMaterial' | 'BakedGood' | 'DecoratedGood' | 'Miscellaneous'
  uom: string | null
  packmultiplier: number
  currentstock: number
}

// --- purchases ---

export interface PurchaseTicket {
  transactionId: string
  date: string
  supplier: string | null
  totalAmount: number
}

export interface PurchaseLine {
  transactionId: string
  date: string
  sku: string
  qty: number
  unitCost: number
  supplier: string | null
}

// --- deliveries ---

// `status` is the ticket-grain MIN(status) across every delivery_logs row
// sharing this transaction_id - one ticket splits into several rows when FIFO
// consumes multiple lots, and they are only ever read or written together.
export interface DeliveryTicket {
  transactionId: string
  date: string
  toBranch: string
  totalItems: number
  requester: string | null
  reason: string | null
  totalCost: number
  status: 'InTransit' | 'Accepted'
}

export interface DeliveryLine {
  transactionId: string
  date: string
  sku: string
  qty: number
  toBranch: string
  totalLineCost: number
  requester: string | null
  reason: string | null
}

// --- adjustments ---

export interface AdjustmentRow {
  date: string
  sku: string
  brand: string | null
  baseName: string | null
  qtyDelta: number
  unitCost: number
  reason: string | null
  branch: string
}

// --- production ---

export interface ProductionBatch {
  transactionId: string
  date: string
  recipeId: number
  recipeName: string | null
  staffName: string | null
  batchMultiplier: number
  outputSku: string
  outputQty: number
  totalInputCost: number
}

// --- POS sales ---

export interface SaleSummary {
  localId: number
  clientSaleId: string
  staffName: string | null
  soldAt: string
  totalAmount: number
  paymentMethod: string
  voided: boolean
  hasShortfall: boolean
}

export interface SaleLine {
  sku: string | null // null on a discount line
  description: string
  qty: number
  unitPrice: number
  lineTotal: number
  shortfallQty: number
}

// GET /api/sales/lines - one row per item per sale, flattened with its parent
// sale's identity. Feeds the CSV export (the same shape frmSalesReport's Excel
// export consumes); voided sales are included, flagged by `voided`.
export interface SaleLineExport {
  saleNo: number
  clientSaleId: string
  soldAt: string
  staffName: string
  voided: boolean
  paymentMethod: string
  sku: string | null
  description: string
  qty: number
  unitPrice: number
  lineTotal: number
  shortfallQty: number
  // Server's selling price for the SKU at sync time; null on discount lines and
  // on rows written before migration 009. unitPrice != catalogPrice means the
  // sale was rung at a stale cached price (the owner changed it after the POS
  // cached its catalog) - recorded, never rejected. Not in the byte-compatible
  // CSV export (buildSalesCsv/buildCsv list their columns explicitly).
  catalogPrice: number | null
}

// POST /api/sales's write-side contract (webapp-pos-plan.md Increment 4) -
// mirrors Program.cs's PosSaleDto/PosSaleLineDto/PosSaleSyncResult exactly
// (C# PascalCase binds case-insensitively, but these use the same camelCase
// convention every other write endpoint in this file already does). The
// server has no custom JSON options, so its `decimal` fields bind from a
// JSON NUMBER token, not a string - unlike some other money fields in this
// codebase's client code, these must NOT be sent as toFixed() strings.
// pos/money.ts's centavosToWireNumber() converts from the internal integer-
// centavo value to that number exactly once, at serialization time.
export interface PosSaleLineDto {
  sku: string | null // null = discount line, no inventory effect
  description: string
  qty: number
  unitPrice: number
  lineTotal: number
}

export interface PosSaleDto {
  clientSaleId: string // GUID minted offline by the POS - the idempotency key
  branch: string
  staffName: string
  soldAt: string // counter time (localTimestamp()), not sync time
  totalAmount: number
  paymentMethod: string // Cash | GCash | GCash Terminal | Foodpanda
  lines: PosSaleLineDto[]
}

export interface PosSaleSyncResult {
  clientSaleId: string
  status: 'Synced' | 'AlreadySynced' | 'SyncedWithShortfall' | 'Rejected'
  detail: string
}

// --- recipes (owner-managed; baking and decorating share one shape) ---

export interface RecipeLine {
  inputSku: string
  qty: number
}

export interface Recipe {
  recipeId: number
  name: string
  kind: 'Baking' | 'Decorating'
  outputSku: string
  outputQty: number
  isActive: boolean
  lines: RecipeLine[]
}

// POST/PUT body. Note there is no recipeId and no isActive: create and replace
// both take this shape, and activation is a separate PATCH.
export interface RecipeInput {
  name: string
  kind: 'Baking' | 'Decorating'
  outputSku: string
  outputQty: number
  lines: RecipeLine[]
}

// --- classification ---

// PUT /api/inventory/{sku}/classification writes category, uom AND
// pack_multiplier in a single UPDATE with no COALESCE, so a partial body blanks
// the fields it omits. Always send all three, prefilled from the current row.
export interface ClassificationInput {
  category: InventoryRow['category']
  uom: string | null
  packMultiplier: number
}
