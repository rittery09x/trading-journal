"""
Campaign Builder
================
Converts the grouping engine DataFrame to DB-ready records for Supabase.

Produces:
  - campaigns:          list[dict] → campaigns table
  - option_legs:        list[dict] → option_legs table (with deterministic IDs)
  - execution_updates:  list[dict] → update raw_executions with campaign_id / leg_group_id

Deterministic UUIDs (uuid5) ensure idempotent upserts on re-import:
  - campaign_id  = uuid5(ns, "campaign:{UNDERLYING}")
  - option_leg id = uuid5(ns, "optleg:{ibkr_trade_id}")

Roll FK resolution (rolled_to_leg_id / rolled_from_leg_id) is done within this
module once all leg IDs are known, so the API layer can do a straight upsert.
"""

from __future__ import annotations

import math
import uuid
from typing import Any, Optional

import pandas as pd

# ──────────────────────────────────────────────────────────────────────────────
# Deterministic UUID namespaces
# ──────────────────────────────────────────────────────────────────────────────

_CAMPAIGN_NS = uuid.UUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")
_OPTLEG_NS   = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c9")


def _campaign_id(underlying: str) -> str:
    return str(uuid.uuid5(_CAMPAIGN_NS, f"campaign:{underlying.strip().upper()}"))


def _optleg_id(ibkr_trade_id: str) -> str:
    return str(uuid.uuid5(_OPTLEG_NS, f"optleg:{ibkr_trade_id}"))


# ──────────────────────────────────────────────────────────────────────────────
# Type helpers
# ──────────────────────────────────────────────────────────────────────────────

def _safe(val: Any) -> Optional[Any]:
    """Returns None for NaN/None, else the value."""
    if val is None:
        return None
    if isinstance(val, float) and math.isnan(val):
        return None
    return val


def _date_str(val: Any) -> Optional[str]:
    """Returns ISO date string YYYY-MM-DD or None."""
    v = _safe(val)
    if v is None:
        return None
    s = str(v)
    return s[:10] if len(s) >= 10 else s


def _float(val: Any) -> Optional[float]:
    v = _safe(val)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _bool(val: Any) -> bool:
    v = _safe(val)
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    return str(v).lower() in ("true", "1", "yes")


def _str(val: Any) -> str:
    v = _safe(val)
    return str(v).strip() if v is not None else ""


# ──────────────────────────────────────────────────────────────────────────────
# Leg type / status derivation
# ──────────────────────────────────────────────────────────────────────────────

def _leg_type(option_type: str, action: str) -> str:
    """Derives option leg type from option_type (C/P) and action (BUY/SELL)."""
    ot = _str(option_type).upper()
    ac = _str(action).upper()
    if ot == "P":
        return "short_put" if ac == "SELL" else "long_put"
    elif ot == "C":
        return "short_call" if ac == "SELL" else "long_call"
    return "long_put"


def _leg_status(row: dict) -> str:
    """
    Derives option leg status.
    Priority: expired > assigned > rolled (BTC) > closed > open
    """
    if _bool(row.get("is_expired")):
        return "expired"
    if _bool(row.get("is_assignment")):
        return "assigned"
    # A BTC that was rolled has a rolled_to_id set
    if _safe(row.get("rolled_to_id")):
        return "rolled"
    oci = _str(row.get("open_close_indicator")).upper()
    if oci == "C":
        return "closed"
    return "open"


# ──────────────────────────────────────────────────────────────────────────────
# Main builder
# ──────────────────────────────────────────────────────────────────────────────

def build_campaigns_and_legs(df: pd.DataFrame) -> dict:
    """
    Converts the grouping engine output DataFrame to DB-ready records.

    Args:
        df: Output of run_grouping_pipeline()

    Returns:
        {
          "campaigns":         list[dict],
          "option_legs":       list[dict],
          "execution_updates": list[dict],
        }
    """
    campaigns_map: dict[str, dict] = {}   # campaign_id → record
    option_legs: list[dict] = []
    execution_updates: list[dict] = []

    # ibkr_trade_id → option_leg UUID (for roll FK resolution)
    ibkr_to_leg_id: dict[str, str] = {}

    for _, row in df.iterrows():
        r = row.to_dict()

        campaign_key  = _safe(r.get("campaign_key"))     # = underlying symbol
        ibkr_id       = _str(r.get("ibkr_trade_id"))
        asset_class   = _str(r.get("asset_class")).upper()
        action        = _str(r.get("action")).upper()
        underlying    = _str(r.get("underlying") or r.get("symbol"))
        trade_date    = _date_str(r.get("trade_date"))
        currency      = _str(r.get("currency")) or "USD"

        # ── Campaign initialization ─────────────────────────────────────────
        camp_id: Optional[str] = None
        if campaign_key:
            camp_id = _campaign_id(str(campaign_key))

            if camp_id not in campaigns_map:
                campaigns_map[camp_id] = {
                    "id": camp_id,
                    "underlying": str(campaign_key).strip().upper(),
                    "status": "open",
                    "strategy_type": "custom",
                    "started_at": trade_date,
                    "stock_quantity": 0.0,
                    "effective_avg_cost": None,
                    "broker_avg_cost": None,
                    "total_option_premium": 0.0,
                    "cost_basis_adjustment": 0.0,
                    "realized_pnl_total": 0.0,
                    "open_option_legs": 0,
                    "currency": currency,
                    "notes": None,
                }

            camp = campaigns_map[camp_id]

            # Update started_at to min trade date
            if trade_date and (camp["started_at"] is None or trade_date < camp["started_at"]):
                camp["started_at"] = trade_date

            # Stock quantity tracking
            qty = _float(r.get("quantity")) or 0.0
            if asset_class == "STK":
                if action == "BUY":
                    camp["stock_quantity"] += qty
                    price = _float(r.get("price"))
                    if price and camp["broker_avg_cost"] is None:
                        camp["broker_avg_cost"] = price
                elif action == "SELL":
                    camp["stock_quantity"] -= qty

            # Realized PnL accumulation
            rpnl = _float(r.get("realized_pnl")) or 0.0
            camp["realized_pnl_total"] += rpnl

        # ── Execution update (for raw_executions back-fill) ─────────────────
        execution_updates.append({
            "ibkr_trade_id": ibkr_id,
            "campaign_id":   camp_id,
            "leg_group_id":  str(_safe(r.get("leg_group_id")) or ""),
        })

        # ── Option leg record ───────────────────────────────────────────────
        if asset_class == "OPT":
            oci    = _str(r.get("open_close_indicator")).upper()
            status = _leg_status(r)

            # Track open legs per campaign
            if camp_id and oci == "O" and status == "open":
                campaigns_map[camp_id]["open_option_legs"] += 1

            # Net PnL
            gross_pnl  = _float(r.get("realized_pnl"))
            commission = abs(_float(r.get("commission")) or 0.0)
            net_pnl    = (gross_pnl - commission) if gross_pnl is not None else None

            # Accumulate option premium into campaign
            if camp_id and net_pnl is not None and status in ("closed", "expired", "assigned", "rolled"):
                campaigns_map[camp_id]["total_option_premium"] += net_pnl
                if status == "rolled":
                    campaigns_map[camp_id]["cost_basis_adjustment"] += net_pnl

            cost_basis_carried = _float(r.get("cost_basis_carried")) or 0.0

            leg_id = _optleg_id(ibkr_id)
            ibkr_to_leg_id[ibkr_id] = leg_id

            option_legs.append({
                "id":               leg_id,
                "campaign_id":      camp_id,
                # temporary fields for roll FK resolution (removed below)
                "_ibkr_id":         ibkr_id,
                "_rolled_to_ibkr":  _safe(r.get("rolled_to_id")),
                "_rolled_from_ibkr": _safe(r.get("rolled_from_id")),
                # DB columns
                "leg_type":         _leg_type(_str(r.get("option_type")), action),
                "status":           status,
                "strike":           _float(r.get("option_strike")),
                "expiry":           _date_str(r.get("option_expiry")),
                "open_date":        trade_date,
                "open_price":       _float(r.get("price")),
                "close_price":      None,
                "quantity":         _float(r.get("quantity")),
                "multiplier":       _float(r.get("option_multiplier")) or 100.0,
                "gross_pnl":        gross_pnl,
                "commission_total": commission,
                "net_pnl":          net_pnl,
                "cost_basis_carried": cost_basis_carried,
                "rolled_to_leg_id":   None,   # resolved below
                "rolled_from_leg_id": None,   # resolved below
            })

    # ── Resolve roll FK references ──────────────────────────────────────────
    for leg in option_legs:
        leg["rolled_to_leg_id"]   = ibkr_to_leg_id.get(leg.pop("_rolled_to_ibkr")   or "") or None
        leg["rolled_from_leg_id"] = ibkr_to_leg_id.get(leg.pop("_rolled_from_ibkr") or "") or None
        leg.pop("_ibkr_id")

    # ── Finalize campaign status ────────────────────────────────────────────
    for camp in campaigns_map.values():
        if camp["open_option_legs"] == 0 and camp["stock_quantity"] == 0:
            camp["status"] = "closed"
        # Effective avg cost: broker cost minus collected premiums per share
        stk_qty = camp["stock_quantity"]
        if camp["broker_avg_cost"] and stk_qty > 0:
            prem_per_share = camp["total_option_premium"] / stk_qty
            camp["effective_avg_cost"] = camp["broker_avg_cost"] - prem_per_share

    return {
        "campaigns":         list(campaigns_map.values()),
        "option_legs":       option_legs,
        "execution_updates": execution_updates,
    }
