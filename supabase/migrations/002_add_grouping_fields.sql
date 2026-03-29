-- ============================================================
-- Migration: 002_add_grouping_fields.sql
-- Adds grouping helper fields to raw_executions so that the
-- grouping engine can operate on Supabase-fetched data (needed
-- for correct cross-import roll detection).
-- ============================================================

ALTER TABLE raw_executions
    ADD COLUMN IF NOT EXISTS brokerage_order_id    TEXT,
    ADD COLUMN IF NOT EXISTS open_close_indicator  TEXT,
    ADD COLUMN IF NOT EXISTS is_expired            BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_assignment         BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_sto                BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_btc                BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_raw_executions_campaign_id_leg
    ON raw_executions (campaign_id, leg_group_id);
