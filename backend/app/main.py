import math
import os
from datetime import date, datetime
from typing import Any, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(
    title="Trading Journal Parser",
    description="IBKR Flex Query XML Parser & Grouping Engine",
    version="2.0.0",
)

# ── CORS ──────────────────────────────────────────────────────────────────────

allowed_origins = [
    "http://localhost:3000",
    os.getenv("NEXT_PUBLIC_APP_URL", "https://trading.cari-digital.de"),
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── JSON serialization helper ─────────────────────────────────────────────────

def _json_safe(obj: Any) -> Any:
    """Recursively converts non-JSON-serializable types (datetime, date, NaN)."""
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, float) and math.isnan(obj):
        return None
    return obj


# ── Pydantic models ───────────────────────────────────────────────────────────

class ParseRequest(BaseModel):
    activity_xml: Optional[str] = None
    confirms_xml: Optional[str] = None


class Position(BaseModel):
    symbol: str
    asset_class: str
    underlying: Optional[str] = None
    expiry: Optional[str] = None
    option_type: Optional[str] = None
    strike: Optional[float] = None
    quantity: Optional[float] = None


class LivePricesRequest(BaseModel):
    positions: List[Position]


class GroupRequest(BaseModel):
    executions: List[dict]


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "trading-journal-parser"}


@app.post("/parse")
async def parse(body: ParseRequest):
    """
    Parse IBKR Flex Query XMLs (Activity Feed + Trade Confirms).
    Accepts a JSON body with raw XML strings (activity_xml, confirms_xml).

    Returns structured executions, FX transactions, cash transactions
    and account snapshots ready for Supabase upsert.
    """
    activity_xml: Optional[str] = body.activity_xml or None
    confirms_xml: Optional[str] = body.confirms_xml or None

    if not activity_xml and not confirms_xml:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one XML source (activity_xml or confirms_xml)",
        )

    # DEBUG: log XML structure to identify element names
    import xml.etree.ElementTree as ET
    if activity_xml:
        try:
            dbg_root = ET.fromstring(activity_xml)
            dbg_children = [c.tag for c in dbg_root][:10]
            dbg_trades = dbg_root.findall(".//Trade")
            dbg_all_tags = list({el.tag for el in dbg_root.iter()})[:30]
            print(f"[DEBUG AF] root.tag={dbg_root.tag} root.attrib={dict(dbg_root.attrib)}")
            print(f"[DEBUG AF] direct children tags: {dbg_children}")
            print(f"[DEBUG AF] Trade elements found: {len(dbg_trades)}")
            print(f"[DEBUG AF] all tags in XML: {sorted(dbg_all_tags)}")
            print(f"[DEBUG AF] XML snippet: {activity_xml[:500]}")
        except Exception as e:
            print(f"[DEBUG AF] parse error: {e}")

    from app.parser import merge_feeds

    result = merge_feeds(activity_xml, confirms_xml)

    return _json_safe({
        "executions":        result.executions,
        "fx_transactions":   result.fx_transactions,
        "cash_transactions": result.cash_transactions,
        "account_snapshots": result.account_snapshots,
        "stats":             result.stats,
    })


@app.post("/group")
def group(request: GroupRequest):
    """
    Run the grouping engine + campaign builder on a list of executions.

    Input: list of execution dicts (from /parse or fetched from Supabase).
    Returns campaigns, option_legs and execution_updates ready for Supabase upsert.

    Note: Pass ALL known executions (not just new ones) for correct roll detection
    across multiple imports.
    """
    from app.grouping_engine import run_grouping_pipeline
    from app.campaign_builder import build_campaigns_and_legs

    if not request.executions:
        return {
            "campaigns":         [],
            "option_legs":       [],
            "execution_updates": [],
            "stats": {"total": 0, "rolls": 0, "campaigns": 0},
        }

    df = run_grouping_pipeline(request.executions)
    result = build_campaigns_and_legs(df)

    roll_count = int(df["roll_group_id"].notna().sum() // 2)  # pairs

    result["stats"] = {
        "total":       len(request.executions),
        "rolls":       roll_count,
        "campaigns":   len(result["campaigns"]),
        "option_legs": len(result["option_legs"]),
    }

    return _json_safe(result)


@app.post("/live-prices")
def live_prices(request: LivePricesRequest):
    """
    Fetch live prices for a list of positions via yfinance (15-min cache).
    Returns one result dict per position, in the same order.
    """
    from app.live_prices import get_live_prices_bulk

    positions = [p.model_dump() for p in request.positions]
    results   = get_live_prices_bulk(positions)
    return {"results": results}
