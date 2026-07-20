-- ====================================================================
-- Migration 007: webapp accounts + sessions (idempotent)
-- Run: psql "$CONNECTION_STRING" -f migrations/007_webapp_auth.sql
--
-- Pure additions - no existing table is touched, so the currently-deployed
-- API keeps working unchanged between this migration and the redeploy that
-- introduces the auth code (the usual migrate-before-redeploy window).
-- ====================================================================

-- Webapp logins. WinForms clients never authenticate against this table; they
-- stay on the cookie-less IP-allowlist path exactly as before.
CREATE TABLE IF NOT EXISTS app_users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,                 -- PBKDF2-SHA256$iters$saltB64$hashB64
    role VARCHAR(20) NOT NULL,
    branch_name VARCHAR(100),                    -- required for Branch, meaningless otherwise
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_app_users_role CHECK (role IN ('Owner', 'Office', 'Branch')),
    CONSTRAINT chk_app_users_branch CHECK (role <> 'Branch' OR branch_name IS NOT NULL)
);

-- Logins are matched case-insensitively, so 'Owner' must not be creatable
-- alongside 'owner'. Violating this raises 23505 like the column UNIQUE does,
-- which the create-user endpoint already turns into a clean 409.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_username_lower ON app_users(LOWER(username));

-- One row per live browser session. Only the SHA-256 of the cookie token is
-- stored, so a database dump can't be replayed as a set of live sessions.
CREATE TABLE IF NOT EXISTS app_sessions (
    token_hash CHAR(64) PRIMARY KEY,             -- hex SHA-256 of the raw cookie value
    user_id INTEGER NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);

-- Serves the expired-session sweep that piggybacks on login.
CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at);

-- Seed the owner account with a sentinel hash that can never verify (it has
-- none of the PBKDF2 format's fields), so the account exists but is unusable
-- until the owner sets a real password through POST /api/auth/bootstrap from
-- an owner device. Deliberately no plaintext password in this file.
INSERT INTO app_users (username, password_hash, role)
VALUES ('owner', '!', 'Owner')
ON CONFLICT (username) DO NOTHING;
