-- ====================================================================
-- Migration 003: baking/decorating production module (idempotent)
-- Run: psql "$CONNECTION_STRING" -f migrations/003_production_module.sql
-- ====================================================================

-- Product category: existing rows are all supplies purchased by Office today,
-- so they default to RawMaterial. BakedGood/DecoratedGood are created going
-- forward via the classification endpoint as recipes are set up.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'RawMaterial';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_category') THEN
        ALTER TABLE inventory
            ADD CONSTRAINT chk_inventory_category CHECK (category IN ('RawMaterial', 'BakedGood', 'DecoratedGood'));
    END IF;
END $$;

-- Recipes are global (one shared company-wide list, not per-branch), matching
-- the inventory table's natural-key style rather than the branch_name pattern.
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
