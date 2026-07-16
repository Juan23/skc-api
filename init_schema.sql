-- ====================================================================
-- SKC BAKERY CENTRAL DATABASE SCHEMA (POSTGRESQL 15+)
-- ====================================================================

-- 1. Create Inventory Table (Global Master Catalog)
CREATE TABLE IF NOT EXISTS inventory (
    sku VARCHAR(100) PRIMARY KEY,
    brand VARCHAR(255),
    base_name VARCHAR(255) NOT NULL,
    uom VARCHAR(50),
    pack_multiplier NUMERIC(18, 4) DEFAULT 1.0,
    price NUMERIC(18, 2) DEFAULT 0.00,
    is_active BOOLEAN DEFAULT TRUE,
    foodpanda_sku VARCHAR(255),
    category VARCHAR(20) NOT NULL DEFAULT 'RawMaterial',
    last_updated TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_inventory_category CHECK (category IN ('RawMaterial', 'BakedGood', 'DecoratedGood'))
);

-- Index for scanning SKU lookups
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory(sku);

-- 2. Create Purchase Logs Table
CREATE TABLE IF NOT EXISTS purchase_logs (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,           -- Identifies which physical store sent the data
    local_id INTEGER NOT NULL,                   -- The auto-increment ID from the local branch SQLite db
    transaction_id VARCHAR(100),
    date TIMESTAMP WITHOUT TIME ZONE,
    sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    qty INTEGER NOT NULL,
    unit_cost NUMERIC(18, 4) NOT NULL,
    supplier VARCHAR(255),
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- UNIQUE constraint prevents syncing the same branch record twice
    CONSTRAINT uq_branch_purchase_log UNIQUE (branch_name, local_id)
);

CREATE INDEX IF NOT EXISTS idx_purchases_branch_date ON purchase_logs(branch_name, date);
CREATE INDEX IF NOT EXISTS idx_purchases_sku ON purchase_logs(sku);

-- 3. Create Delivery Logs Table
CREATE TABLE IF NOT EXISTS delivery_logs (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,           -- Identifies the originating branch
    local_id INTEGER NOT NULL,                   -- Local SQLite Delivery ID
    transaction_id VARCHAR(100),
    date TIMESTAMP WITHOUT TIME ZONE,
    sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    qty INTEGER NOT NULL,
    to_branch VARCHAR(100) NOT NULL,
    total_line_cost NUMERIC(18, 4) DEFAULT 0.0000,
    requester VARCHAR(100),
    reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'InTransit', -- acceptance workflow: InTransit until the receiving branch accepts
    accepted_by VARCHAR(100),
    accepted_at TIMESTAMP WITHOUT TIME ZONE,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Prevents double sync of the same delivery
    CONSTRAINT uq_branch_delivery_log UNIQUE (branch_name, local_id),
    CONSTRAINT chk_delivery_status CHECK (status IN ('InTransit', 'Accepted'))
);

CREATE INDEX IF NOT EXISTS idx_deliveries_branch_date ON delivery_logs(branch_name, date);
CREATE INDEX IF NOT EXISTS idx_deliveries_sku ON delivery_logs(sku);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON delivery_logs(to_branch, status);

-- 4. Create Inventory Lots Table (Central FIFO ledger copy)
CREATE TABLE IF NOT EXISTS inventory_lots (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,
    lot_id INTEGER NOT NULL,                     -- The LotId from the local SQLite db
    sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    date_received TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    original_qty INTEGER NOT NULL,
    remaining_qty INTEGER NOT NULL,
    unit_cost NUMERIC(18, 4) NOT NULL,
    purchase_transaction_id VARCHAR(100),        -- Links back to purchase_logs.transaction_id when the lot came from a purchase; NULL for adjustment-created lots
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Prevents duplicating lot tracking entries
    CONSTRAINT uq_branch_inventory_lot UNIQUE (branch_name, lot_id),
    CONSTRAINT chk_remaining_qty_non_negative CHECK (remaining_qty >= 0)
);

CREATE INDEX IF NOT EXISTS idx_lots_branch_sku ON inventory_lots(branch_name, sku);
CREATE INDEX IF NOT EXISTS idx_lots_purchase_txn ON inventory_lots(purchase_transaction_id);

-- 5. Create Inventory Adjustments Table (manual stock count reconciliation log)
CREATE TABLE IF NOT EXISTS inventory_adjustments (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,
    sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    date TIMESTAMP WITHOUT TIME ZONE,
    qty_delta INTEGER NOT NULL,
    unit_cost NUMERIC(18, 4) NOT NULL,
    reason TEXT,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_adjustments_sku_date ON inventory_adjustments(sku, date);

-- 6. Baking/decorating production module (recipes are global, not per-branch)
CREATE TABLE IF NOT EXISTS recipes (
    recipe_id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    output_sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    output_qty INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_recipe_kind CHECK (kind IN ('Baking', 'Decorating'))
);

CREATE TABLE IF NOT EXISTS recipe_lines (
    id SERIAL PRIMARY KEY,
    recipe_id INTEGER NOT NULL REFERENCES recipes(recipe_id) ON DELETE CASCADE,
    input_sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    qty INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipe_lines_recipe ON recipe_lines(recipe_id);

-- Production batch header: branch-scoped and staff-attributed, same
-- uq_branch_* idempotency pattern as purchase_logs/delivery_logs.
CREATE TABLE IF NOT EXISTS production_batches (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,
    local_id INTEGER NOT NULL,
    transaction_id VARCHAR(100),
    recipe_id INTEGER REFERENCES recipes(recipe_id),
    staff_name VARCHAR(100) NOT NULL,
    date TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    batch_multiplier NUMERIC(18, 4) NOT NULL DEFAULT 1,
    output_sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    output_qty INTEGER NOT NULL,
    total_input_cost NUMERIC(18, 4) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_branch_production UNIQUE (branch_name, local_id)
);

CREATE INDEX IF NOT EXISTS idx_production_branch_date ON production_batches(branch_name, date);

-- Per-batch consumption ledger: snapshots what was actually taken at the time,
-- so the audit trail survives a later recipe edit (recipe_lines aren't versioned).
CREATE TABLE IF NOT EXISTS production_consumed (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,
    production_local_id INTEGER NOT NULL,
    transaction_id VARCHAR(100),
    input_sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    qty INTEGER NOT NULL,
    cost NUMERIC(18, 4) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_production_consumed_batch ON production_consumed(branch_name, production_local_id);
