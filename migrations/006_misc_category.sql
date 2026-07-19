-- ====================================================================
-- Migration 006: Miscellaneous product category (idempotent)
-- Run: psql "$CONNECTION_STRING" -f migrations/006_misc_category.sql
-- ====================================================================

-- Miscellaneous is for non-baking sellable items (candles, cellophane, etc.) that
-- were previously mistagged as RawMaterial just to exist in the catalog at all -
-- see the classification endpoint comment in Program.cs for the old rationale.
-- Drop-and-recreate is safe here: the constraint only checks a value list, there's
-- no data shape change, and existing rows already satisfy the widened list.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_category') THEN
        ALTER TABLE inventory DROP CONSTRAINT chk_inventory_category;
    END IF;
    ALTER TABLE inventory
        ADD CONSTRAINT chk_inventory_category CHECK (category IN ('RawMaterial', 'BakedGood', 'DecoratedGood', 'Miscellaneous'));
END $$;
