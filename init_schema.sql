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

    CONSTRAINT chk_inventory_category CHECK (category IN ('RawMaterial', 'BakedGood', 'DecoratedGood', 'Miscellaneous'))
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
-- A recipe has FIXED inputs (recipe_lines) but a MENU of possible outputs
-- (recipe_outputs) - one bake can yield several finished-good types at once
-- (see migration 010 + webapp-multi-output-production-plan.md).
CREATE TABLE IF NOT EXISTS recipes (
    recipe_id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    -- DEPRECATED single-output columns (superseded by recipe_outputs). Kept
    -- nullable for old rows / the CLI's pending migration; a future cleanup
    -- migration drops them. New code never writes them.
    output_sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    output_qty INTEGER,
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

-- Recipe output menu: which finished goods a recipe can produce, each with a
-- relative size weight used to split a batch's ingredient cost across the
-- outputs actually made (cost share proportional to qty x weight).
CREATE TABLE IF NOT EXISTS recipe_outputs (
    id         SERIAL PRIMARY KEY,
    recipe_id  INTEGER NOT NULL REFERENCES recipes(recipe_id) ON DELETE CASCADE,
    output_sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    weight     NUMERIC(18,4) NOT NULL DEFAULT 1,
    CONSTRAINT uq_recipe_output UNIQUE (recipe_id, output_sku),
    CONSTRAINT chk_recipe_output_weight CHECK (weight > 0)
);

CREATE INDEX IF NOT EXISTS idx_recipe_outputs_recipe ON recipe_outputs(recipe_id);

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
    -- DEPRECATED single-output columns (superseded by production_outputs). Kept
    -- nullable for old rows; new code leaves them NULL. Future migration drops.
    output_sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    output_qty INTEGER,
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

-- Per-batch output ledger: what a batch actually made, one row per finished-good
-- type, with the recipe weight and per-unit cost snapshotted at bake time (so a
-- later recipe-weight edit never rewrites history). unit_cost = weight x
-- (total_input_cost / weightedUnits); cost = unit_cost x qty; lot_id is the
-- inventory_lots row credited for this output.
CREATE TABLE IF NOT EXISTS production_outputs (
    id                  SERIAL PRIMARY KEY,
    branch_name         VARCHAR(100) NOT NULL,
    production_local_id INTEGER NOT NULL,
    transaction_id      VARCHAR(100),
    output_sku          VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    qty                 INTEGER NOT NULL,
    weight              NUMERIC(18, 4) NOT NULL,
    unit_cost           NUMERIC(18, 4) NOT NULL,
    lot_id              INTEGER,
    cost                NUMERIC(18, 4) NOT NULL,
    CONSTRAINT chk_production_output_qty CHECK (qty >= 0)
);

CREATE INDEX IF NOT EXISTS idx_production_outputs_batch ON production_outputs(branch_name, production_local_id);

-- 7. POS sales (offline-first branch point-of-sale)
-- Idempotency key is (branch_name, client_sale_id): the POS mints a GUID
-- offline, so a wiped/reinstalled local db can't collide with rows that
-- already synced. local_id is server-assigned (MAX+1 under the branch
-- advisory lock) purely as a human-friendly id for reports.
CREATE TABLE IF NOT EXISTS pos_sales (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,
    local_id INTEGER NOT NULL,
    client_sale_id VARCHAR(100) NOT NULL,
    staff_name VARCHAR(100) NOT NULL,
    sold_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,   -- counter time, not sync time (offline sales sync late)
    total_amount NUMERIC(18, 2) NOT NULL,
    payment_method VARCHAR(50) NOT NULL DEFAULT 'Cash', -- Cash, GCash, GCash Terminal, Foodpanda, ... (client-controlled set, no CHECK)
    voided BOOLEAN NOT NULL DEFAULT FALSE,          -- a voided sale is restocked and flagged, never deleted
    voided_at TIMESTAMP WITHOUT TIME ZONE,
    voided_by VARCHAR(100),
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_branch_pos_sale UNIQUE (branch_name, client_sale_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_sales_branch_date ON pos_sales(branch_name, sold_at);

-- Sale lines. sku is NULL for discount lines (a generic negative line, no
-- inventory effect). shortfall_qty records the portion FIFO couldn't cover at
-- sync time (oversell is warn-but-allow at the counter; the server never
-- rejects a sale for stock). consumed_cost rolls up what FIFO actually took.
CREATE TABLE IF NOT EXISTS pos_sale_lines (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,
    client_sale_id VARCHAR(100) NOT NULL,
    sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    description VARCHAR(255) NOT NULL,
    qty INTEGER NOT NULL,
    unit_price NUMERIC(18, 2) NOT NULL,
    line_total NUMERIC(18, 2) NOT NULL,
    shortfall_qty INTEGER NOT NULL DEFAULT 0,
    consumed_cost NUMERIC(18, 4) NOT NULL DEFAULT 0,
    catalog_price NUMERIC(18, 2)   -- server selling price at sync time; NULL for discount lines / pre-009 rows (see migrations/009). Warn-not-reject stale-price detection.
);

CREATE INDEX IF NOT EXISTS idx_pos_sale_lines_sale ON pos_sale_lines(branch_name, client_sale_id);

-- 8. Webapp accounts + sessions (mirrors migrations/007_webapp_auth.sql)
-- WinForms clients never touch these tables - they stay on the cookie-less
-- IP-allowlist path. See 007 for the rationale on the sentinel owner hash.
CREATE TABLE IF NOT EXISTS app_users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,                 -- PBKDF2-SHA256$iters$saltB64$hashB64
    role VARCHAR(20) NOT NULL,
    branch_name VARCHAR(100),                    -- required for Branch, meaningless otherwise
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_app_users_role CHECK (role IN ('Owner', 'Office', 'Branch')),
    CONSTRAINT chk_app_users_branch CHECK (role <> 'Branch' OR branch_name IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_username_lower ON app_users(LOWER(username));

CREATE TABLE IF NOT EXISTS app_sessions (
    token_hash CHAR(64) PRIMARY KEY,             -- hex SHA-256 of the raw cookie value
    user_id INTEGER NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at);

INSERT INTO app_users (username, password_hash, role)
VALUES ('owner', '!', 'Owner')
ON CONFLICT (username) DO NOTHING;

-- ====================================================================
-- 9. Device -> tier registry (mirrors migrations/011_app_devices.sql)
-- ====================================================================
-- One row per trusted Tailscale device. The three IP gates read an in-process
-- snapshot of the active rows; a tier hierarchy (Owner satisfies Office and any
-- branch) reproduces the old overlapping literal allowlists without duplicate rows.
CREATE TABLE IF NOT EXISTS app_devices (
    device_id    SERIAL PRIMARY KEY,
    tailscale_ip VARCHAR(45) NOT NULL UNIQUE,       -- canonical IPv4 dotted-quad (MapToIPv4)
    tier         VARCHAR(20) NOT NULL,              -- Owner | Office | Branch
    branch_name  VARCHAR(100),                      -- required for Branch, meaningless otherwise
    label        VARCHAR(200),                      -- human note ("Owner laptop")
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_app_devices_tier   CHECK (tier IN ('Owner', 'Office', 'Branch')),
    CONSTRAINT chk_app_devices_branch CHECK (tier <> 'Branch' OR branch_name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_app_devices_active ON app_devices(is_active);

-- Seed = the original hardcoded device allowlists, one row per device at its
-- highest tier. ON CONFLICT so a re-run never clobbers owner-edited rows.
INSERT INTO app_devices (tailscale_ip, tier, branch_name, label) VALUES
    ('100.108.218.24', 'Owner',  NULL,   'Owner laptop'),
    ('100.81.94.66',   'Owner',  NULL,   'Owner phone'),
    ('100.69.186.113', 'Owner',  NULL,   'Home server (threelittlebears)'),
    ('100.66.61.24',   'Office', NULL,   'SKC Bakery Supplies office PC'),
    ('100.81.76.53',   'Branch', 'Yoho', 'Yoho store PC')
ON CONFLICT (tailscale_ip) DO NOTHING;

-- ====================================================================
-- 10. POS cashier registry (mirrors migrations/012_pos_staff.sql)
-- ====================================================================
-- Owner-managed per-branch staff list backing the web POS cashier picker.
-- PIN salt+hash are served to tills and cached in IndexedDB for offline
-- verification - accountability-grade attribution, not access control.
CREATE TABLE IF NOT EXISTS pos_staff (
    staff_id    SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,   -- plain string, exact-match like everywhere (no branches table)
    staff_name  VARCHAR(100) NOT NULL,   -- the exact string written to pos_sales.staff_name
    pin_salt    TEXT NOT NULL,           -- 16 random bytes, lowercase hex
    pin_hash    TEXT NOT NULL,           -- lowercase hex SHA-256(UTF8(pin_salt || pin))
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Case-insensitive per-branch uniqueness ('Ana'/'ana' would be
-- indistinguishable on the picker and in reports); still raises 23505.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_staff_branch_name
    ON pos_staff (branch_name, LOWER(staff_name));

CREATE INDEX IF NOT EXISTS idx_pos_staff_branch_active
    ON pos_staff (branch_name, is_active);

-- No seed rows: an empty branch = that branch's tills use the free-text
-- staff-name fallback until the owner adds its cashiers.
