-- ====================================================================
-- Migration 001: fix inventory_lots column mismatch, add purchase
-- linkage, add non-negative guard, add inventory_adjustments table.
--
-- Idempotent: safe to run against a database that already has some or
-- all of these changes applied (e.g. a fresh install created from the
-- current init_schema.sql already has everything below and this
-- migration is a no-op there).
--
-- Run manually against the droplet's Postgres instance, e.g.:
--   psql "$CONNECTION_STRING" -f migrations/001_fix_lots_and_adjustments.sql
-- ====================================================================

-- 1. Rename the column so it matches every query in Program.cs (which
--    has always used "lot_id", never "local_lot_id").
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'inventory_lots' AND column_name = 'local_lot_id'
    ) THEN
        ALTER TABLE inventory_lots RENAME COLUMN local_lot_id TO lot_id;
    END IF;
END $$;

-- 2. Link lots back to the purchase that created them, so purchase
--    deletion can target the exact lots instead of guessing by
--    sku+qty+unit_cost.
ALTER TABLE inventory_lots
    ADD COLUMN IF NOT EXISTS purchase_transaction_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_lots_purchase_txn ON inventory_lots(purchase_transaction_id);

-- 3. Defense-in-depth: never allow remaining_qty to go negative, even
--    if a future code path forgets to lock rows before deducting.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_remaining_qty_non_negative'
    ) THEN
        ALTER TABLE inventory_lots
            ADD CONSTRAINT chk_remaining_qty_non_negative CHECK (remaining_qty >= 0);
    END IF;
END $$;

-- 4. inventory_adjustments was referenced by Program.cs but never
--    defined in the schema - create it now.
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

-- NOTE: existing inventory_lots rows created before this migration will
-- have purchase_transaction_id = NULL, since there is no reliable way
-- to reconstruct which purchase ticket created them after the fact.
-- Purchase-ticket deletion for those older lots will not find a
-- matching purchase_transaction_id and will simply leave the lots in
-- place (no rows deleted) rather than guessing - this is intentional.
