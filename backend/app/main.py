import math
import os
from datetime import date, datetime
from typing import Any, List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
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
async def parse(
    activity_file: Optional[UploadFile] = File(None),
    confirms_file: Optional[UploadFile] = File(None),
    body: Optional[ParseRequest] = None,
):
    """
    Parse IBKR Flex Query XMLs (Activity Feed + Trade Confirms).
    Accepts multipart file uploads OR JSON body with raw XML strings.

    Returns structured executions, FX transactions, cash transactions
    and account snapshots ready for Supabase upsert.
    """
    activity_xml: Optional[str] = None
    confirms_xml: Optional[str] = None

    if activity_file:
        activity_xml = (await activity_file.read()).decode("utf-8")
    elif body and body.activity_xml:
        activity_xml = body.activity_xml

    if confirms_file:
        confirms_xml = (await confirms_file.read()).decode("utf-8")
    elif body and body.confirms_xml:
        confirms_xml = body.confirms_xml

    if not activity_xml and not confirms_xml:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one XML source (activity_xml or confirms_xml)",
        )

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
