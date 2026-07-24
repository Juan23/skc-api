-- ====================================================================
-- Migration 011: device -> tier registry (idempotent)
-- Run: docker exec -i central_postgres psql -U central_admin -d skc_central < migrations/011_app_devices.sql
--
-- Moves the Tailscale device->tier allowlists out of Program.cs (the hardcoded
-- trustedOfficeIps / ownerIps / branchIps literals) into a table the owner can
-- edit from the webapp. Pure addition - no existing table is touched, so the
-- currently-deployed API keeps working unchanged between this migration and the
-- redeploy that introduces the registry code (the usual migrate-before-redeploy
-- window - the old image ignores this table entirely).
-- ====================================================================

-- One row per trusted Tailscale device. The three IP gates read an in-process
-- snapshot of the active rows; a tier hierarchy (Owner satisfies Office and any
-- branch) reproduces today's overlapping literal sets without duplicate rows.
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

-- The snapshot query filters on is_active.
CREATE INDEX IF NOT EXISTS idx_app_devices_active ON app_devices(is_active);

-- Seed = exactly today's hardcoded literals, one row per physical device at its
-- HIGHEST tier (the tier hierarchy handles office/branch fall-through). ON CONFLICT
-- so a re-run never clobbers a row the owner later edited through the webapp.
INSERT INTO app_devices (tailscale_ip, tier, branch_name, label) VALUES
    ('100.108.218.24', 'Owner',  NULL,   'Owner laptop'),
    ('100.81.94.66',   'Owner',  NULL,   'Owner phone'),
    ('100.69.186.113', 'Owner',  NULL,   'Home server (threelittlebears)'),
    ('100.66.61.24',   'Office', NULL,   'SKC Bakery Supplies office PC'),
    ('100.81.76.53',   'Branch', 'Yoho', 'Yoho store PC')
ON CONFLICT (tailscale_ip) DO NOTHING;
