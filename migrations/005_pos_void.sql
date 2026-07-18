-- ====================================================================
-- Migration 005: POS sale voiding (idempotent)
-- Run: psql "$CONNECTION_STRING" -f migrations/005_pos_void.sql
-- ====================================================================

-- Voiding a completed sale reverses its inventory effect (restocks what FIFO
-- actually consumed) and flags the sale rather than deleting it, so the audit
-- trail survives. These columns are added nullable/defaulted, so the currently
-- deployed API keeps working against the post-migration schema until the new
-- image is deployed (migrate-before-redeploy window).
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS voided_by VARCHAR(100);
