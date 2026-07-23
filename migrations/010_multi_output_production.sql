-- ====================================================================
-- Migration 010: multi-output production (idempotent)
-- Run: docker exec -i central_postgres psql -U central_admin -d skc_central < migrations/010_multi_output_production.sql
--
-- One recipe can now yield several finished-good types from a single bake.
-- The recipe's INPUTS stay fixed (recipe_lines unchanged); only the OUTPUT
-- side changes. Each recipe declares a MENU of possible outputs, each with a
-- relative size WEIGHT; a batch's total ingredient cost splits across the
-- outputs actually made, proportional to qty x weight.
--
-- This migration is additive: the old single-output columns
-- (recipes.output_sku/output_qty, production_batches.output_sku/output_qty)
-- are made nullable and left in place (deprecated) so the currently-running
-- API keeps working until the new image deploys. A FUTURE cleanup migration
-- drops them once the skcadmin CLI is updated (see webapp-multi-output-
-- production-plan.md sec 6 + bug-track.md).
-- ====================================================================

-- 1. Recipe output menu: which finished goods a recipe can produce + weights.
CREATE TABLE IF NOT EXISTS recipe_outputs (
    id         SERIAL PRIMARY KEY,
    recipe_id  INTEGER NOT NULL REFERENCES recipes(recipe_id) ON DELETE CASCADE,
    output_sku VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    weight     NUMERIC(18,4) NOT NULL DEFAULT 1,
    CONSTRAINT uq_recipe_output UNIQUE (recipe_id, output_sku),
    CONSTRAINT chk_recipe_output_weight CHECK (weight > 0)
);
CREATE INDEX IF NOT EXISTS idx_recipe_outputs_recipe ON recipe_outputs(recipe_id);

-- 2. Per-batch output ledger: what a batch actually made, with the weight and
--    cost snapshotted at bake time (so a later recipe-weight edit never
--    rewrites history) - same philosophy as production_consumed for inputs.
CREATE TABLE IF NOT EXISTS production_outputs (
    id                  SERIAL PRIMARY KEY,
    branch_name         VARCHAR(100) NOT NULL,
    production_local_id INTEGER NOT NULL,
    transaction_id      VARCHAR(100),
    output_sku          VARCHAR(100) REFERENCES inventory(sku) ON UPDATE CASCADE,
    qty                 INTEGER NOT NULL,
    weight              NUMERIC(18,4) NOT NULL,
    unit_cost           NUMERIC(18,4) NOT NULL,
    lot_id              INTEGER,
    cost                NUMERIC(18,4) NOT NULL,
    CONSTRAINT chk_production_output_qty CHECK (qty >= 0)
);
CREATE INDEX IF NOT EXISTS idx_production_outputs_batch
    ON production_outputs(branch_name, production_local_id);

-- 3. Backfill recipe_outputs from existing single-output recipes (weight = 1;
--    with one output the weight is irrelevant to the split, so 1 is a safe
--    identity). Guarded so re-running the migration can't duplicate rows.
INSERT INTO recipe_outputs (recipe_id, output_sku, weight)
SELECT r.recipe_id, r.output_sku, 1
FROM recipes r
WHERE r.output_sku IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM recipe_outputs ro WHERE ro.recipe_id = r.recipe_id);

-- 4. Backfill production_outputs from existing batches so the rewritten
--    GET /api/production still shows historical production. lot_id is left NULL
--    (the original credited lot isn't re-derivable after the fact).
INSERT INTO production_outputs
    (branch_name, production_local_id, transaction_id, output_sku, qty, weight, unit_cost, lot_id, cost)
SELECT p.branch_name, p.local_id, p.transaction_id, p.output_sku, p.output_qty, 1,
       CASE WHEN p.output_qty > 0 THEN p.total_input_cost / p.output_qty ELSE 0 END,
       NULL,
       p.total_input_cost
FROM production_batches p
WHERE p.output_sku IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM production_outputs po
      WHERE po.branch_name = p.branch_name AND po.production_local_id = p.local_id
  );

-- 5. Deprecate the old single-output columns: relax NOT NULL so new inserts
--    that omit them succeed. Columns are kept (not dropped) for old rows and
--    for the pre-deploy running image; a future migration drops them.
ALTER TABLE recipes            ALTER COLUMN output_qty DROP NOT NULL;
ALTER TABLE production_batches ALTER COLUMN output_qty DROP NOT NULL;
-- output_sku on both tables is already nullable.
