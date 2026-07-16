-- ====================================================================
-- Migration 002: delivery acceptance workflow (idempotent)
-- Run: psql "$CONNECTION_STRING" -f migrations/002_delivery_status.sql
-- ====================================================================

-- Backfill lives INSIDE the column-add guard: rows existing at migration time
-- predate the acceptance workflow and become 'Accepted' (so branches don't see
-- months of historical deliveries as pending); new rows default to 'InTransit'.
-- A re-run can't flip genuine InTransit rows back to Accepted because the
-- UPDATE only executes when the column is first created.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'delivery_logs' AND column_name = 'status') THEN
        ALTER TABLE delivery_logs ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'InTransit';
        UPDATE delivery_logs SET status = 'Accepted';
    END IF;
END $$;

-- accepted_by/accepted_at stay NULL for backfilled historical rows (unknown).
ALTER TABLE delivery_logs ADD COLUMN IF NOT EXISTS accepted_by VARCHAR(100);
ALTER TABLE delivery_logs ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP WITHOUT TIME ZONE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_delivery_status') THEN
        ALTER TABLE delivery_logs
            ADD CONSTRAINT chk_delivery_status CHECK (status IN ('InTransit', 'Accepted'));
    END IF;
END $$;

-- Serves the branch apps' pending-deliveries poll.
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON delivery_logs(to_branch, status);
