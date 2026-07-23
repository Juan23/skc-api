-- ====================================================================
-- Migration 008: POS payment method (idempotent)
-- Run: psql "$CONNECTION_STRING" -f migrations/008_pos_payment_method.sql
-- ====================================================================

-- Records how a sale was paid (Cash, GCash, GCash Terminal, Foodpanda, ...).
-- Added NOT NULL DEFAULT 'Cash' so (a) existing rows backfill to Cash and
-- (b) the currently-deployed API's INSERT into pos_sales (which omits this
-- column) keeps working against the post-migration schema until the new image
-- is deployed (migrate-before-redeploy window). No CHECK constraint on the
-- value set: the allowed methods are controlled client-side, and a CHECK would
-- both leak a Postgres constraint error to callers and force a migration every
-- time a new method (e.g. Maya) is added.
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) NOT NULL DEFAULT 'Cash';
