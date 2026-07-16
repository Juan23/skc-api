-- ====================================================================
-- Migration 004: POS sales (offline-first branch point-of-sale) (idempotent)
-- Run: psql "$CONNECTION_STRING" -f migrations/004_pos_sales.sql
-- ====================================================================

-- No pricing migration needed: inventory.price already exists (dormant legacy
-- column) and becomes the single company-wide selling price. Sellable = price > 0.

-- Sale header. Idempotency key is (branch_name, client_sale_id): the POS mints
-- a GUID offline, so a wiped/reinstalled local db can't collide with rows that
-- already synced (unlike a restarting local autoincrement). local_id is still
-- assigned server-side (MAX+1 under the branch advisory lock) purely as a
-- human-friendly id for reports.
CREATE TABLE IF NOT EXISTS pos_sales (
    id SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,
    local_id INTEGER NOT NULL,
    client_sale_id VARCHAR(100) NOT NULL,
    staff_name VARCHAR(100) NOT NULL,
    sold_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,   -- counter time, not sync time (offline sales sync late)
    total_amount NUMERIC(18, 2) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_branch_pos_sale UNIQUE (branch_name, client_sale_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_sales_branch_date ON pos_sales(branch_name, sold_at);

-- Sale lines. sku is NULL for discount lines (a generic negative line, no
-- inventory effect). shortfall_qty records the portion FIFO couldn't cover at
-- sync time (oversell is warn-but-allow at the counter; the server never
-- rejects a sale for stock). consumed_cost rolls up what FIFO actually took,
-- for margin reporting later.
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
    consumed_cost NUMERIC(18, 4) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pos_sale_lines_sale ON pos_sale_lines(branch_name, client_sale_id);
