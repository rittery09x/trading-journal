"""
Campaign Builder
================
Converts the grouping engine DataFrame to DB-ready records for Supabase.

Produces:
  - campaigns:          list[dict] → campaigns table
  - option_legs:        list[dict] → option_legs table (with deterministic IDs)
  - execution_updates:  list[dict] → update raw_executions with campaign_id / leg_group_id

Design: one option_leg per POSITION (not per execution).
  A position = unique (campaign, option_type, strike, expiry).
  Multiple partial fills are aggregated into one leg.
  Status is derived from closing events (BTC / expiry / assignment) found for that position.

Deterministic UUIDs (uuid5) ensure idempotent upserts on re-import:
  - campaign_id  = uuid5(ns, "campaign:{UNDERLYING}")
  - option_leg id = uuid5(ns, "optleg:{first_ibkr_trade_id_of_position}")
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
    if val is None:
        return None
    if isinstance(val, float) and math.isnan(val):
        return None
    return val


def _date_str(val: Any) -> Optional[str]:
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
# Leg type derivation
# ──────────────────────────────────────────────────────────────────────────────

def _leg_type(option_type: str, action: str) -> str:
    ot = _str(option_type).upper()
    ac = _str(action).upper()
    if ot == "P":
        return "short_put" if ac == "SELL" else "long_put"
    elif ot == "C":
        return "short_call" if ac == "SELL" else "long_call"
    return "long_put"


# ──────────────────────────────────────────────────────────────────────────────
# Main builder
# ──────────────────────────────────────────────────────────────────────────────

def build_campaigns_and_legs(df: pd.DataFrame) -> dict:
    """
    Converts the grouping engine output DataFrame to DB-ready records.

    One option_leg is created per POSITION (campaign + option_type + strike + expiry),
    aggregating all partial fills. Status is derived from matching closing events.

    Args:
        df: Output of run_grouping_pipeline()

    Returns:
        {
          "campaigns":         list[dict],
          "option_legs":       list[dict],
          "execution_updates": list[dict],
        }
    """
    campaigns_map: dict[str, dict] = {}
    execution_updates: list[dict] = []

    # position key → {"openings": [...], "closings": [...]}
    # key = (camp_id, option_type, strike, expiry)
    pos_data: dict[tuple, dict] = {}

    # ── Pass 1: Build campaigns + collect OPT executions by position ──────────
    for _, row in df.iterrows():
        r = row.to_dict()

        campaign_key  = _safe(r.get("campaign_key"))
        ibkr_id       = _str(r.get("ibkr_trade_id"))
        asset_class   = _str(r.get("asset_class")).upper()
        action        = _str(r.get("action")).upper()
        trade_date    = _date_str(r.get("trade_date"))
        currency      = _str(r.get("currency")) or "USD"

        # ── Campaign init ───────────────────────────────────────────────────
        camp_id: Optional[str] = None
        if campaign_key:
            camp_id = _campaign_id(str(campaign_key))

            if camp_id not in campaigns_map:
                campaigns_map[camp_id] = {
                    "id":                    camp_id,
                    "underlying":            str(campaign_key).strip().upper(),
                    "status":                "open",
                    "strategy_type":         "custom",
                    "started_at":            trade_date,
                    "stock_quantity":        0.0,
                    "effective_avg_cost":    None,
                    "broker_avg_cost":       None,
                    "total_option_premium":  0.0,
                    "cost_basis_adjustment": 0.0,
                    "realized_pnl_total":    0.0,
                    "open_option_legs":      0,
                    "currency":              currency,
                    "notes":                 None,
                }

            camp = campaigns_map[camp_id]

            if trade_date and (camp["started_at"] is None or trade_date < camp["started_at"]):
                camp["started_at"] = trade_date

            # Stock tracking
            qty = abs(_float(r.get("quantity")) or 0.0)
            if asset_class == "STK":
                if action == "BUY":
                    camp["stock_quantity"] += qty
                    price = _float(r.get("price"))
                    if price and camp["broker_avg_cost"] is None:
                        camp["broker_avg_cost"] = price
                elif action == "SELL":
                    camp["stock_quantity"] -= qty

            rpnl = _float(r.get("realized_pnl")) or 0.0
            camp["realized_pnl_total"] += rpnl

        # ── Execution update ────────────────────────────────────────────────
        execution_updates.append({
            "ibkr_trade_id": ibkr_id,
            "campaign_id":   camp_id,
            "leg_group_id":  str(_safe(r.get("leg_group_id")) or ""),
        })

        # ── Collect OPT executions by position key ──────────────────────────
        if asset_class == "OPT" and camp_id:
            oci          = _str(r.get("open_close_indicator")).upper()
            is_expired   = _bool(r.get("is_expired"))
            is_assignment = _bool(r.get("is_assignment"))

            pos_key = (
                camp_id,
                _str(r.get("option_type")).upper(),
                _float(r.get("option_strike")),
                _date_str(r.get("option_expiry")),
            )

            if pos_key not in pos_data:
                pos_data[pos_key] = {"openings": [], "closings": []}

            # Opening: OCI=O, not an expiry/assignment correction
            is_opening = (oci == "O" and not is_expired and not is_assignment)

            if is_opening:
                pos_data[pos_key]["openings"].append(r)
            else:
                pos_data[pos_key]["closings"].append(r)

    # ── Pass 2: Build one option_leg per position ─────────────────────────────
    option_legs: list[dict] = []
    ibkr_to_leg_id: dict[str, str] = {}

    for pos_key, data in pos_data.items():
        openings = data["openings"]
        closings = data["closings"]

        if not openings:
            # Closing events with no corresponding opening (e.g. data gap) — skip
            continue

        camp_id, option_type, strike, expiry = pos_key

        # Sort openings by date for deterministic primary ID
        openings = sorted(openings, key=lambda r: r.get("trade_date") or "")
        first    = openings[0]
        primary_ibkr_id = _str(first.get("ibkr_trade_id"))
        leg_id   = _optleg_id(primary_ibkr_id)

        # Register all opening ibkr_ids → this leg
        for r in openings:
            ibkr_to_leg_id[_str(r.get("ibkr_trade_id"))] = leg_id

        # Register all closing ibkr_ids → this leg (for rolled_from FK on successor)
        for r in closings:
            ibkr_to_leg_id[_str(r.get("ibkr_trade_id"))] = leg_id

        # ── Determine status ────────────────────────────────────────────────
        has_roll       = any(_safe(r.get("rolled_to_id")) for r in closings)
        has_expiry     = any(_bool(r.get("is_expired"))   for r in closings)
        has_assignment = any(_bool(r.get("is_assignment")) for r in closings)

        total_open_qty  = sum(abs(_float(r.get("quantity")) or 0) for r in openings)
        total_close_qty = sum(abs(_float(r.get("quantity")) or 0) for r in closings)

        if has_roll:
            status = "rolled"
        elif has_expiry:
            status = "expired"
        elif has_assignment:
            status = "assigned"
        elif total_close_qty >= total_open_qty * 0.99:  # fully closed (99% threshold)
            status = "closed"
        elif closings:
            status = "open"   # partially closed
        else:
            status = "open"

        # ── Prices ─────────────────────────────────────────────────────────
        # Weighted-average open price across partial fills
        total_price_weighted = sum(
            (_float(r.get("price")) or 0.0) * abs(_float(r.get("quantity")) or 0.0)
            for r in openings
        )
        open_price = total_price_weighted / total_open_qty if total_open_qty > 0 else None

        # Weighted-average close price (0 for expiry)
        close_price: Optional[float] = None
        if closings and not has_expiry:
            total_close_weighted = sum(
                (_float(r.get("price")) or 0.0) * abs(_float(r.get("quantity")) or 0.0)
                for r in closings
            )
            close_price = total_close_weighted / total_close_qty if total_close_qty > 0 else None

        # ── PnL ────────────────────────────────────────────────────────────
        gross_pnl: Optional[float] = None
        if closings:
            pnl_values = [_float(r.get("realized_pnl")) for r in closings]
            valid = [v for v in pnl_values if v is not None]
            if valid:
                gross_pnl = sum(valid)

        commission = sum(
            abs(_float(r.get("commission")) or 0.0)
            for r in openings + closings
        )
        net_pnl = (gross_pnl - commission) if gross_pnl is not None else None

        # ── Roll references ─────────────────────────────────────────────────
        rolled_to_ibkr: Optional[str] = None
        if has_roll:
            roll_btcs = [r for r in closings if _safe(r.get("rolled_to_id"))]
            if roll_btcs:
                rolled_to_ibkr = str(_safe(roll_btcs[0].get("rolled_to_id")))

        rolled_from_ibkr: Optional[str] = None
        rolled_froms = [r for r in openings if _safe(r.get("rolled_from_id"))]
        if rolled_froms:
            rolled_from_ibkr = str(_safe(rolled_froms[0].get("rolled_from_id")))

        # ── Cost basis carried (roll-in) ────────────────────────────────────
        cost_basis_carried = _float(first.get("cost_basis_carried")) or 0.0

        # ── Leg type from first opening ─────────────────────────────────────
        first_action = _str(first.get("action")).upper()
        leg_type     = _leg_type(_str(first.get("option_type")), first_action)

        # ── Update campaign totals ──────────────────────────────────────────
        if camp_id in campaigns_map:
            if status in ("closed", "expired", "assigned", "rolled") and net_pnl is not None:
                campaigns_map[camp_id]["total_option_premium"] += net_pnl
                if status == "rolled":
                    campaigns_map[camp_id]["cost_basis_adjustment"] += net_pnl

            if status == "open":
                campaigns_map[camp_id]["open_option_legs"] += 1

        option_legs.append({
            "id":               leg_id,
            "campaign_id":      camp_id,
            # temporary fields for roll FK resolution (removed below)
            "_ibkr_id":         primary_ibkr_id,
            "_rolled_to_ibkr":  rolled_to_ibkr,
            "_rolled_from_ibkr": rolled_from_ibkr,
            # DB columns
            "leg_type":           leg_type,
            "status":             status,
            "strike":             strike,
            "expiry":             expiry,
            "open_date":          _date_str(first.get("trade_date")),
            "open_price":         open_price,
            "close_price":        close_price,
            "quantity":           total_open_qty,
            "multiplier":         _float(first.get("option_multiplier")) or 100.0,
            "gross_pnl":          gross_pnl,
            "commission_total":   commission,
            "net_pnl":            net_pnl,
            "cost_basis_carried": cost_basis_carried,
            "rolled_to_leg_id":   None,   # resolved below
            "rolled_from_leg_id": None,   # resolved below
        })

    # ── Resolve roll FK references ────────────────────────────────────────────
    for leg in option_legs:
        leg["rolled_to_leg_id"]   = ibkr_to_leg_id.get(leg.pop("_rolled_to_ibkr")   or "") or None
        leg["rolled_from_leg_id"] = ibkr_to_leg_id.get(leg.pop("_rolled_from_ibkr") or "") or None
        leg.pop("_ibkr_id")

    # ── Finalize campaign status ──────────────────────────────────────────────
    for camp in campaigns_map.values():
        camp["open_option_legs"] = max(0, camp["open_option_legs"])
        camp["stock_quantity"]   = max(0.0, camp["stock_quantity"])
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
