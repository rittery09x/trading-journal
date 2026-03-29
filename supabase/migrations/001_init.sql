-- ============================================================
-- Trading Journal — Initial Schema
-- Migration: 001_init.sql
-- ============================================================
-- RLS Strategie (Single-User App):
--   Service Role Key → voller Zugriff (INSERT/UPDATE/DELETE/SELECT)
--   Anon Key         → nur SELECT auf nicht-sensiblen Tabellen
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ============================================================
-- TABLE: campaigns
-- Muss zuerst erstellt werden (raw_executions hat FK darauf)
-- ============================================================
CREATE TABLE campaigns (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    underlying              TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'closed')),
    strategy_type           TEXT NOT NULL DEFAULT 'custom'
                                CHECK (strategy_type IN (
                                    'short_put', 'covered_call', 'spread',
                                    'iron_condor', 'custom'
                                )),
    started_at              DATE NOT NULL,
    closed_at               DATE,
    stock_quantity          NUMERIC NOT NULL DEFAULT 0,
    effective_avg_cost      NUMERIC,       -- Einstieg nach Prämien-Anpassung
    broker_avg_cost         NUMERIC,       -- Einstieg laut Broker
    total_option_premium    NUMERIC NOT NULL DEFAULT 0,  -- Summe aller net_pnl der Legs
    cost_basis_adjustment   NUMERIC NOT NULL DEFAULT 0,  -- kumulierte Roll-Verluste
    realized_pnl_total      NUMERIC NOT NULL DEFAULT 0,
    open_option_legs        INT NOT NULL DEFAULT 0,
    currency                TEXT NOT NULL DEFAULT 'USD',
    notes                   TEXT,
    last_updated            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON campaigns
    USING (auth.role() = 'service_role');

CREATE POLICY "anon_read" ON campaigns
    FOR SELECT
    USING (auth.role() = 'anon');

CREATE INDEX idx_campaigns_underlying ON campaigns (underlying);
CREATE INDEX idx_campaigns_status     ON campaigns (status);


-- ============================================================
-- TABLE: raw_executions
-- ============================================================
CREATE TABLE raw_executions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ibkr_trade_id       TEXT UNIQUE NOT NULL,
    account_id          TEXT,
    symbol              TEXT NOT NULL,
    underlying          TEXT,              -- Basiswert (z.B. AAPL für AAPL-Optionen)
    asset_class         TEXT NOT NULL
                            CHECK (asset_class IN ('STK', 'OPT', 'CASH', 'FX')),
    action              TEXT NOT NULL
                            CHECK (action IN ('BUY', 'SELL')),
    quantity            NUMERIC NOT NULL,
    price               NUMERIC NOT NULL,
    currency            TEXT NOT NULL,
    commission          NUMERIC NOT NULL DEFAULT 0,
    realized_pnl        NUMERIC,
    trade_date          TIMESTAMPTZ NOT NULL,
    settle_date         DATE,
    option_expiry       DATE,
    option_strike       NUMERIC,
    option_type         TEXT CHECK (option_type IN ('C', 'P')),
    option_multiplier   NUMERIC NOT NULL DEFAULT 100,
    campaign_id         UUID REFERENCES campaigns (id) ON DELETE SET NULL,
    leg_group_id        TEXT,              -- Multi-Leg Timestamp-Grouping
    notes               TEXT,
    mood                INT CHECK (mood BETWEEN 1 AND 5),
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_xml             JSONB
);

ALTER TABLE raw_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON raw_executions
    USING (auth.role() = 'service_role');

CREATE POLICY "anon_read" ON raw_executions
    FOR SELECT
    USING (auth.role() = 'anon');

CREATE INDEX idx_raw_executions_campaign_id  ON raw_executions (campaign_id);
CREATE INDEX idx_raw_executions_trade_date   ON raw_executions (trade_date);
CREATE INDEX idx_raw_executions_underlying   ON raw_executions (underlying);
CREATE INDEX idx_raw_executions_asset_class  ON raw_executions (asset_class);
CREATE INDEX idx_raw_executions_leg_group_id ON raw_executions (leg_group_id);


-- ============================================================
-- TABLE: option_legs
-- Self-referencing für Roll-Ketten
-- ============================================================
CREATE TABLE option_legs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
    execution_id        UUID REFERENCES raw_executions (id) ON DELETE SET NULL,
    leg_type            TEXT NOT NULL
                            CHECK (leg_type IN (
                                'short_put', 'long_put',
                                'short_call', 'long_call'
                            )),
    status              TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN (
                                'open', 'closed', 'expired', 'assigned', 'rolled'
                            )),
    strike              NUMERIC NOT NULL,
    expiry              DATE NOT NULL,
    open_date           TIMESTAMPTZ NOT NULL,
    close_date          TIMESTAMPTZ,
    open_price          NUMERIC NOT NULL,  -- Prämie beim Einstieg (pro Aktie)
    close_price         NUMERIC,           -- Rückkaufpreis (pro Aktie)
    quantity            NUMERIC NOT NULL,
    multiplier          NUMERIC NOT NULL DEFAULT 100,
    gross_pnl           NUMERIC,           -- (open_price - close_price) * qty * multiplier
    commission_total    NUMERIC NOT NULL DEFAULT 0,
    net_pnl             NUMERIC,           -- gross_pnl - commission_total
    -- Roll-Verknüpfung (self-referencing)
    rolled_to_leg_id    UUID REFERENCES option_legs (id) ON DELETE SET NULL,
    rolled_from_leg_id  UUID REFERENCES option_legs (id) ON DELETE SET NULL,
    cost_basis_carried  NUMERIC NOT NULL DEFAULT 0  -- übertragener Verlust aus vorherigem Roll
);

ALTER TABLE option_legs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON option_legs
    USING (auth.role() = 'service_role');

CREATE POLICY "anon_read" ON option_legs
    FOR SELECT
    USING (auth.role() = 'anon');

CREATE INDEX idx_option_legs_campaign_id        ON option_legs (campaign_id);
CREATE INDEX idx_option_legs_status             ON option_legs (status);
CREATE INDEX idx_option_legs_expiry             ON option_legs (expiry);
CREATE INDEX idx_option_legs_rolled_to_leg_id   ON option_legs (rolled_to_leg_id);
CREATE INDEX idx_option_legs_rolled_from_leg_id ON option_legs (rolled_from_leg_id);


-- ============================================================
-- TABLE: fx_transactions
-- ============================================================
CREATE TABLE fx_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ibkr_trade_id   TEXT UNIQUE NOT NULL,
    from_currency   TEXT NOT NULL,
    to_currency     TEXT NOT NULL,
    from_amount     NUMERIC NOT NULL,
    to_amount       NUMERIC NOT NULL,
    rate            NUMERIC NOT NULL,
    trade_date      DATE NOT NULL,
    description     TEXT
);

ALTER TABLE fx_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON fx_transactions
    USING (auth.role() = 'service_role');

CREATE POLICY "anon_read" ON fx_transactions
    FOR SELECT
    USING (auth.role() = 'anon');

CREATE INDEX idx_fx_transactions_trade_date ON fx_transactions (trade_date);


-- ============================================================
-- TABLE: cash_transactions
-- ============================================================
CREATE TABLE cash_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ibkr_trade_id   TEXT UNIQUE,
    type            TEXT NOT NULL
                        CHECK (type IN (
                            'dividend', 'interest', 'fee',
                            'deposit', 'withdrawal', 'withholding_tax'
                        )),
    amount          NUMERIC NOT NULL,
    currency        TEXT NOT NULL,
    description     TEXT NOT NULL,
    date            DATE NOT NULL,
    campaign_id     UUID REFERENCES campaigns (id) ON DELETE SET NULL
);

ALTER TABLE cash_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON cash_transactions
    USING (auth.role() = 'service_role');

CREATE POLICY "anon_read" ON cash_transactions
    FOR SELECT
    USING (auth.role() = 'anon');

CREATE INDEX idx_cash_transactions_date        ON cash_transactions (date);
CREATE INDEX idx_cash_transactions_type        ON cash_transactions (type);
CREATE INDEX idx_cash_transactions_campaign_id ON cash_transactions (campaign_id);


-- ============================================================
-- TABLE: account_snapshots
-- ============================================================
CREATE TABLE account_snapshots (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_date           DATE UNIQUE NOT NULL,
    net_liquidation_eur     NUMERIC NOT NULL,
    net_liquidation_usd     NUMERIC NOT NULL,
    cash_eur                NUMERIC NOT NULL,
    cash_usd                NUMERIC NOT NULL,
    raw_data                JSONB
);

ALTER TABLE account_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON account_snapshots
    USING (auth.role() = 'service_role');

CREATE POLICY "anon_read" ON account_snapshots
    FOR SELECT
    USING (auth.role() = 'anon');

CREATE INDEX idx_account_snapshots_date ON account_snapshots (snapshot_date);


-- ============================================================
-- COMPUTED COLUMNS (via generated columns / functions)
-- ============================================================

-- Hilfsfunktion: DTE (Days to Expiry) für offene Option Legs
CREATE OR REPLACE FUNCTION dte(expiry DATE)
RETURNS INT
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT (expiry - CURRENT_DATE)::INT;
$$;

-- Hilfsfunktion: Break-Even eines Option Legs unter Berücksichtigung von Rolls
-- Break-Even für Short PUT: strike - (open_price - cost_basis_carried / qty / multiplier)
CREATE OR REPLACE FUNCTION leg_break_even(
    strike          NUMERIC,
    open_price      NUMERIC,
    cost_basis_carried NUMERIC,
    quantity        NUMERIC,
    multiplier      NUMERIC
)
RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT strike - (open_price - (cost_basis_carried / NULLIF(quantity * multiplier, 0)));
$$;
