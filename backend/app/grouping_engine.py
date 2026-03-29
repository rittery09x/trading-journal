"""
Grouping Engine
===============
Pandas-basierte Logik zur Anreicherung von rohen Executions mit:

  1. leg_group_id        — Multi-Leg Timestamp-Grouping
                           Primär:  brokerageOrderID (gleiche Order = gleiches Leg-Group)
                           Fallback: 60-Sekunden-Fenster auf dasselbe Underlying

  2. roll_group_id       — Identifiziert Roll-Paare (BTC + STO gleicher Richtung)
  3. rolled_from_id      — tradeID des geschlossenen Legs (im neuen STO)
  4. rolled_to_id        — tradeID des neuen Legs (im alten BTC)
  5. cost_basis_carried  — realized_pnl des BTC übertragen in das neue STO-Leg
  6. campaign_key        — Underlying (Basis für Campaign-Zuordnung)

Roll-Erkennungsregeln:
  - Gleiches Underlying
  - BTC (OCI=C, BUY) + STO (OCI=O, SELL) gleicher Richtung (C→C oder P→P)
  - Neues Verfallsdatum (STO.expiry > BTC.expiry)
  - Zeitfenster: 0 < delta <= ROLL_WINDOW_SECONDS (default 300 = 5 Minuten)
    Achtung: echte Rolls liegen 34 Sek. bis ~2 Min. auseinander
  - STO muss NACH BTC liegen (keine Rückwärts-Zuordnung)
  - Jedes BTC und jedes STO wird nur einmal zugeordnet (1:1 Matching, greedy)
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

import pandas as pd

# ──────────────────────────────────────────────────────────────────────────────
# Konstanten
# ──────────────────────────────────────────────────────────────────────────────

ROLL_WINDOW_SECONDS = 300       # 5 Minuten
MULTI_LEG_WINDOW_SECONDS = 60   # 60 Sekunden für Fallback-Grouping


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _to_utc(dt_str: Optional[str]) -> Optional[datetime]:
    """Parst ISO-8601 UTC-String aus dem Parser zurück in datetime."""
    if not dt_str:
        return None
    try:
        return datetime.fromisoformat(dt_str)
    except ValueError:
        return None


def _delta_seconds(a: Optional[datetime], b: Optional[datetime]) -> Optional[float]:
    """b - a in Sekunden. None wenn eines der Timestamps fehlt."""
    if a is None or b is None:
        return None
    return (b - a).total_seconds()


# ──────────────────────────────────────────────────────────────────────────────
# Schritt 1: Multi-Leg Timestamp-Grouping
# ──────────────────────────────────────────────────────────────────────────────

def group_multi_leg(df: pd.DataFrame) -> pd.DataFrame:
    """
    Weist leg_group_id zu.

    Primär: Alle Rows mit derselben nicht-leeren brokerageOrderID → gleiche ID.
    Fallback: Rows ohne brokerageOrderID, die innerhalb von 60 Sekunden auf
              dasselbe Underlying handeln → gleiche ID.

    Rows die weder einer Gruppe zugeordnet werden können (z.B. BookTrade/Expired)
    erhalten eine eindeutige Einzel-ID (damit leg_group_id nie NULL ist).
    """
    df = df.copy()
    df["leg_group_id"] = None

    # ── Primär: brokerageOrderID ──────────────────────────────────────────────
    has_boid = df["brokerage_order_id"].notna() & (df["brokerage_order_id"] != "")
    boid_groups = df.loc[has_boid].groupby("brokerage_order_id")
    for boid, grp in boid_groups:
        gid = str(uuid.uuid4())
        df.loc[grp.index, "leg_group_id"] = gid

    # ── Fallback: 60-Sekunden-Fenster ────────────────────────────────────────
    no_boid = df[~has_boid].copy()
    if not no_boid.empty:
        no_boid["_dt"] = no_boid["trade_date"].apply(_to_utc)
        no_boid = no_boid.sort_values("_dt")

        used = set()
        for idx, row in no_boid.iterrows():
            if idx in used:
                continue
            if row["_dt"] is None:
                continue
            underlying = row.get("underlying") or row.get("symbol", "")
            window_end = row["_dt"] + timedelta(seconds=MULTI_LEG_WINDOW_SECONDS)
            # Suche alle Rows im Fenster mit gleichem Underlying
            mask = (
                (no_boid.index != idx)
                & (no_boid.index.isin(used) == False)
                & (no_boid["_dt"] >= row["_dt"])
                & (no_boid["_dt"] <= window_end)
                & (
                    (no_boid["underlying"] == underlying)
                    | (no_boid["symbol"] == underlying)
                )
            )
            companions = no_boid[mask]
            if not companions.empty:
                gid = str(uuid.uuid4())
                df.loc[idx, "leg_group_id"] = gid
                df.loc[companions.index, "leg_group_id"] = gid
                used.add(idx)
                used.update(companions.index)

    # ── Singletons: jede noch nicht zugeordnete Row bekommt Einzel-ID ─────────
    df.loc[df["leg_group_id"].isna(), "leg_group_id"] = [
        str(uuid.uuid4()) for _ in range(df["leg_group_id"].isna().sum())
    ]

    return df


# ──────────────────────────────────────────────────────────────────────────────
# Schritt 2: Roll-Erkennung
# ──────────────────────────────────────────────────────────────────────────────

def detect_rolls(df: pd.DataFrame) -> pd.DataFrame:
    """
    Erkennt Roll-Paare innerhalb des ROLL_WINDOW_SECONDS (5 Min.) pro Underlying.

    Roll-Kriterien:
      - OCI='C' BUY  (Buy-to-Close, das alte Leg schließen)
      - OCI='O' SELL (Sell-to-Open, das neue Leg öffnen)
      - Gleicher putCall-Typ (C→C oder P→P)
      - STO.expiry > BTC.expiry (neues Verfallsdatum liegt weiter in Zukunft)
      - 0 < (STO.trade_date - BTC.trade_date).seconds <= ROLL_WINDOW_SECONDS
      - Greedy 1:1 Matching (jedes BTC/STO nur einmal)

    Fügt folgende Spalten hinzu:
      roll_group_id    — UUID, identisch für BTC und STO des gleichen Rolls
      rolled_from_id   — (bei STO) tradeID des geschlossenen BTC-Legs
      rolled_to_id     — (bei BTC) tradeID des neuen STO-Legs
      cost_basis_carried — (bei STO) realized_pnl des BTC
    """
    df = df.copy()
    df["roll_group_id"] = None
    df["rolled_from_id"] = None
    df["rolled_to_id"] = None
    df["cost_basis_carried"] = 0.0

    # Nur OPT-Trades mit nicht-expired/assigned Code relevant
    # Expired (is_expired=True) und Assignments (is_assignment=True) sind keine Rolls
    opts = df[
        (df["asset_class"] == "OPT")
        & (df["is_expired"] == False)
        & (df["is_assignment"] == False)
    ].copy()

    opts["_dt"] = opts["trade_date"].apply(_to_utc)
    opts["_expiry_dt"] = opts["option_expiry"].apply(
        lambda x: datetime.strptime(x, "%Y-%m-%d").date() if x else None
    )

    # BTCs: BUY, OCI=C (schließt bestehende Short-Position)
    btcs = opts[
        (opts["action"] == "BUY") & (opts["open_close_indicator"] == "C")
    ].copy()

    # STOs: SELL, OCI=O (öffnet neue Short-Position)
    stos = opts[
        (opts["action"] == "SELL") & (opts["open_close_indicator"] == "O")
    ].copy()

    matched_btc_idx: set = set()
    matched_sto_idx: set = set()

    # Sortiere BTCs nach Zeit für deterministisches Matching
    btcs_sorted = btcs.sort_values("_dt")

    for btc_idx, btc in btcs_sorted.iterrows():
        if btc_idx in matched_btc_idx:
            continue
        if btc["_dt"] is None or btc["_expiry_dt"] is None:
            continue

        btc_underlying = btc.get("underlying") or btc.get("symbol", "")
        btc_put_call = btc["option_type"]  # C oder P
        btc_expiry = btc["_expiry_dt"]
        btc_time = btc["_dt"]
        window_end = btc_time + timedelta(seconds=ROLL_WINDOW_SECONDS)

        # Kandidaten: gleicher Underlying, gleicher putCall-Typ, expiry weiter,
        #             Zeitraum [btc_time, btc_time + 5min]
        candidates = stos[
            (stos.index.isin(matched_sto_idx) == False)
            & (
                (stos["underlying"] == btc_underlying)
                | (stos["symbol"].str.startswith(btc_underlying))
            )
            & (stos["option_type"] == btc_put_call)
            & (stos["_dt"] > btc_time)
            & (stos["_dt"] <= window_end)
            & (stos["_expiry_dt"] > btc_expiry)
        ]

        if candidates.empty:
            continue

        # Nimm den zeitlich nächsten Kandidaten (greedy)
        candidates = candidates.sort_values("_dt")
        sto_idx = candidates.index[0]
        sto = candidates.iloc[0]

        # Roll-Gruppe
        roll_gid = str(uuid.uuid4())
        cost_basis = float(btc.get("realized_pnl") or 0.0)

        df.loc[btc_idx, "roll_group_id"] = roll_gid
        df.loc[btc_idx, "rolled_to_id"] = sto["ibkr_trade_id"]

        df.loc[sto_idx, "roll_group_id"] = roll_gid
        df.loc[sto_idx, "rolled_from_id"] = btc["ibkr_trade_id"]
        df.loc[sto_idx, "cost_basis_carried"] = cost_basis

        matched_btc_idx.add(btc_idx)
        matched_sto_idx.add(sto_idx)

    return df


# ──────────────────────────────────────────────────────────────────────────────
# Schritt 3: Campaign-Zuordnung
# ──────────────────────────────────────────────────────────────────────────────

def assign_campaigns(df: pd.DataFrame) -> pd.DataFrame:
    """
    Weist jedem Trade eine campaign_key zu (= Underlying).

    Regeln:
      - OPT + STK Trades: campaign_key = underlying oder symbol
      - FX/CASH Trades: campaign_key = None
      - Alle Trades desselben Underlyings gehören zur gleichen Campaign
        (Rolls verlängern die Campaign, statt neue zu öffnen)

    Die eigentliche Campaign-Tabellen-Verwaltung (INSERT/UPDATE in Supabase)
    passiert in der API Route /api/import/flex — hier nur campaign_key als
    Vorverarbeitungsschritt.
    """
    df = df.copy()
    df["campaign_key"] = None

    opt_stk = df["asset_class"].isin(["OPT", "STK"])
    df.loc[opt_stk, "campaign_key"] = df.loc[opt_stk, "underlying"].fillna(
        df.loc[opt_stk, "symbol"]
    )

    return df


# ──────────────────────────────────────────────────────────────────────────────
# Schritt 4: Break-Even Berechnung für Roll-Chains
# ──────────────────────────────────────────────────────────────────────────────

def compute_break_even(
    strike: float,
    open_price: float,
    cost_basis_carried: float,
    quantity: float,
    multiplier: float = 100.0,
) -> Optional[float]:
    """
    Break-Even für einen Short PUT nach Roll:
      BE = strike - (open_price - cost_basis_carried / qty / multiplier)

    cost_basis_carried ist positiv wenn Gewinn übertragen, negativ bei Verlust.
    Beispiel:
      Strike=170, open_price=1.26, cost_basis_carried=108, qty=1, mult=100
      → BE = 170 - (1.26 - 108/1/100) = 170 - (1.26 - 1.08) = 170 - 0.18 = 169.82
    """
    if quantity == 0 or multiplier == 0:
        return None
    adjustment = cost_basis_carried / (abs(quantity) * multiplier)
    return strike - (open_price - adjustment)


# ──────────────────────────────────────────────────────────────────────────────
# Schritt 5: Expired Options
# ──────────────────────────────────────────────────────────────────────────────

def detect_expired(df: pd.DataFrame) -> pd.DataFrame:
    """
    Markiert wertlos verfallene Optionen explizit.
    Erkennungsmuster: is_expired=True (bereits vom Parser gesetzt via code=C;Ep).
    Stellt sicher dass realized_pnl korrekt als positiver Gewinn gesetzt ist
    (IBKR liefert fifoPnlRealized als positiven Wert bei Ep).
    """
    df = df.copy()
    expired_mask = df["is_expired"] == True
    # fifoPnlRealized bei Ep ist bereits der Gewinn (die behaltene Prämie)
    # realized_pnl ist schon korrekt gesetzt — keine Korrektur nötig
    return df


# ──────────────────────────────────────────────────────────────────────────────
# Öffentliche Haupt-Pipeline
# ──────────────────────────────────────────────────────────────────────────────

def run_grouping_pipeline(executions: list[dict]) -> pd.DataFrame:
    """
    Vollständige Grouping Pipeline.

    Input:  Liste von Execution-Dicts aus parser.merge_feeds()
    Output: Pandas DataFrame mit allen Anreicherungs-Spalten

    Pipeline-Schritte:
      1. group_multi_leg     → leg_group_id
      2. detect_expired      → stellt expired-Flag sicher
      3. detect_rolls        → roll_group_id, rolled_from_id, rolled_to_id, cost_basis_carried
      4. assign_campaigns    → campaign_key
    """
    df = pd.DataFrame(executions)

    # Sicherstellen dass Boolean-Spalten existieren
    for col in ("is_expired", "is_assignment", "is_sto", "is_btc"):
        if col not in df.columns:
            df[col] = False

    # Sicherstellen dass numerische Spalten existieren
    for col in ("realized_pnl", "option_strike", "quantity", "option_multiplier"):
        if col not in df.columns:
            df[col] = None

    df = group_multi_leg(df)
    df = detect_expired(df)
    df = detect_rolls(df)
    df = assign_campaigns(df)

    return df


# ──────────────────────────────────────────────────────────────────────────────
# Hilfsfunktion: Roll-Chain Report (für Debugging + API)
# ──────────────────────────────────────────────────────────────────────────────

def build_roll_chain_report(df: pd.DataFrame, underlying: str) -> list[dict]:
    """
    Gibt eine menschenlesbare Roll-Chain für ein Underlying zurück.
    Jeder Eintrag beschreibt ein Roll-Paar: {btc, sto, cost_basis_carried, break_even}.
    Expired und Assignment Trades werden separat aufgelistet.
    """
    sub = df[df["campaign_key"] == underlying].copy()
    report = []

    # Roll-Paare
    rolled = sub[sub["roll_group_id"].notna()]
    for roll_gid, grp in rolled.groupby("roll_group_id"):
        btc_rows = grp[(grp["action"] == "BUY") & (grp["open_close_indicator"] == "C")]
        sto_rows = grp[(grp["action"] == "SELL") & (grp["open_close_indicator"] == "O")]
        if btc_rows.empty or sto_rows.empty:
            continue
        btc = btc_rows.iloc[0].to_dict()
        sto = sto_rows.iloc[0].to_dict()

        strike = float(sto.get("option_strike") or 0)
        open_price = float(sto.get("price") or 0)
        cbc = float(sto.get("cost_basis_carried") or 0)
        qty = abs(float(sto.get("quantity") or 1))
        mult = float(sto.get("option_multiplier") or 100)
        be = compute_break_even(strike, open_price, cbc, qty, mult)

        report.append({
            "type": "roll",
            "roll_group_id": roll_gid,
            "direction": sto.get("option_type"),  # C or P
            "btc": {
                "trade_id": btc.get("ibkr_trade_id"),
                "symbol": btc.get("symbol"),
                "expiry": btc.get("option_expiry"),
                "strike": btc.get("option_strike"),
                "price": btc.get("price"),
                "trade_date": btc.get("trade_date"),
                "realized_pnl": btc.get("realized_pnl"),
            },
            "sto": {
                "trade_id": sto.get("ibkr_trade_id"),
                "symbol": sto.get("symbol"),
                "expiry": sto.get("option_expiry"),
                "strike": sto.get("option_strike"),
                "price": open_price,
                "trade_date": sto.get("trade_date"),
            },
            "cost_basis_carried": cbc,
            "break_even": round(be, 4) if be is not None else None,
        })

    # Expired Trades
    expired = sub[sub["is_expired"] == True]
    for _, row in expired.iterrows():
        report.append({
            "type": "expired",
            "trade_id": row.get("ibkr_trade_id"),
            "symbol": row.get("symbol"),
            "expiry": row.get("option_expiry"),
            "strike": row.get("option_strike"),
            "trade_date": row.get("trade_date"),
            "realized_pnl": row.get("realized_pnl"),
        })

    # Assignments
    assignments = sub[sub["is_assignment"] == True]
    for _, row in assignments.iterrows():
        report.append({
            "type": "assignment",
            "trade_id": row.get("ibkr_trade_id"),
            "symbol": row.get("symbol"),
            "asset_class": row.get("asset_class"),
            "quantity": row.get("quantity"),
            "price": row.get("price"),
            "trade_date": row.get("trade_date"),
        })

    # Sortiere nach Datum
    report.sort(key=lambda x: (
        x.get("btc", {}).get("trade_date") or x.get("trade_date") or ""
    ))

    return report
