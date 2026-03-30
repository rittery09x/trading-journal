-- Migration 003: Import Logs
-- Chronological log table for all import runs, errors and warnings.

CREATE TABLE IF NOT EXISTS import_logs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL    DEFAULT now(),
  level          TEXT        NOT NULL    CHECK (level  IN ('info', 'warning', 'error')),
  source         TEXT        NOT NULL    CHECK (source IN ('ibkr', 'parser', 'supabase', 'system')),
  message        TEXT        NOT NULL,
  details        JSONB,
  import_run_id  UUID                    -- groups all log entries for a single import run
);

-- Indexes for the most common query patterns on the logs page
CREATE INDEX IF NOT EXISTS import_logs_created_at_idx ON import_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS import_logs_run_id_idx     ON import_logs (import_run_id) WHERE import_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_logs_level_idx      ON import_logs (level);
CREATE INDEX IF NOT EXISTS import_logs_source_idx     ON import_logs (source);
