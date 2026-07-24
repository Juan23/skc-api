-- ====================================================================
-- Migration 012: POS cashier registry (idempotent)
-- Run: docker exec -i central_postgres psql -U central_admin -d skc_central < migrations/012_pos_staff.sql
--
-- Backs the web POS cashier picker: an owner-managed, per-branch staff list
-- whose PIN salt+hash are served to tills and cached in IndexedDB so PIN
-- checks work offline. Accountability-grade, not security-grade - a 4-digit
-- PIN with a client-cached hash is brute-forceable by design; its job is
-- honest sale attribution, not access control. Pure addition - the
-- currently-deployed API ignores this table entirely, so the usual
-- migrate-before-redeploy window is safe.
-- ====================================================================

CREATE TABLE IF NOT EXISTS pos_staff (
    staff_id    SERIAL PRIMARY KEY,
    branch_name VARCHAR(100) NOT NULL,   -- plain string, exact-match like everywhere (no branches table)
    staff_name  VARCHAR(100) NOT NULL,   -- the exact string written to pos_sales.staff_name
    pin_salt    TEXT NOT NULL,           -- 16 random bytes, lowercase hex
    pin_hash    TEXT NOT NULL,           -- lowercase hex SHA-256(UTF8(pin_salt || pin))
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Case-insensitive per-branch uniqueness: 'Ana' and 'ana' would be
-- indistinguishable on picker buttons and in sales reports (the cleanup
-- sweep already matches staff_name with ILIKE). A unique index still raises
-- 23505, so the devices-style 409 handling applies unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_staff_branch_name
    ON pos_staff (branch_name, LOWER(staff_name));

-- The tills' branch feed filters on (branch_name, is_active).
CREATE INDEX IF NOT EXISTS idx_pos_staff_branch_active
    ON pos_staff (branch_name, is_active);

-- No seed rows: an empty branch is the designed fallback state (that
-- branch's tills keep the free-text staff-name input until the owner adds
-- its cashiers from Owner -> Staff).
