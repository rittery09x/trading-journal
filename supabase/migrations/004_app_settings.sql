-- ============================================================
-- 004_app_settings.sql
-- Single-row settings table for IBKR credentials + auto-import config.
-- Credentials are stored server-side only (no anon read).
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
    id                        BOOLEAN PRIMARY KEY DEFAULT TRUE,  -- enforces single row
    flex_token                TEXT,
    flex_query_id_activity    TEXT,
    flex_query_id_confirms    TEXT,
    auto_import_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
    last_import_at            TIMESTAMPTZ,
    last_import_status        TEXT,   -- 'success' | 'error'
    last_import_message       TEXT,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT single_row CHECK (id = TRUE)
);

-- Insert the default row so GET always returns something
INSERT INTO app_settings (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Only service_role can read or write (credentials must never be exposed to browser)
CREATE POLICY "service_role_only" ON app_settings
    USING (auth.role() = 'service_role');
