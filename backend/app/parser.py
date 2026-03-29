"""
IBKR Flex Query XML Parser
==========================
Parst zwei Flex Query Typen und merged sie via tradeID:

  AF  (Activity Feed / Kontoumsaetze):   <FlexQueryResponse type="AF">
      → Quelle für: Executions (PnL), FxTransactions, CashTransactions, EquitySummary
      → Felder: tradeID, brokerageOrderID, openCloseIndicator, notes, fifoPnlRealized

  TCF (Trade Confirms Feed / Handelsbestaetigung): <FlexQueryResponse type="TCF">
      → Quelle für: code-Feld (O / C / A;O / A;C / C;Ep)
      → STK-Assignment-Einträge teilen dieselbe tradeID wie im AF

Merge-Logik: AF ist Hauptquelle, TCF ergänzt das code-Feld.
Bei Konflikten gewinnt AF.

Zeitzonen: IBKR liefert "20260324;150231" in US-Ostzeit (EST/EDT).
Alle Zeitstempel werden strikt nach UTC konvertiert.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

# IBKR liefert Zeitstempel in US-Eastern (EST/EDT, automatisch DST-aware)
EASTERN = ZoneInfo("America/New_York")
UTC = timezone.utc


# ──────────────────────────────────────────────────────────────────────────────
# Zeitstempel-Parsing
# ──────────────────────────────────────────────────────────────────────────────

def _parse_ibkr_datetime(raw: str) -> Optional[datetime]:
    """
    Konvertiert IBKR-Datetime-String nach UTC.
    Formate: "20260324;150231" oder "20260304" (nur Datum → Mitternacht ET)
    """
    if not raw:
        return None
    raw = raw.strip()
    try:
        if ";" in raw:
            dt_naive = datetime.strptime(raw, "%Y%m%d;%H%M%S")
        else:
            dt_naive = datetime.strptime(raw, "%Y%m%d")
    except ValueError:
        return None
    dt_eastern = dt_naive.replace(tzinfo=EASTERN)
    return dt_eastern.astimezone(UTC)


def _parse_ibkr_date(raw: str) -> Optional[date]:
    """Parst ein reines Datum aus IBKR-Format "20260324"."""
    if not raw:
        return None
    try:
        return datetime.strptime(raw.strip(), "%Y%m%d").date()
    except ValueError:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Dataclasses für Output
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class ParsedExecution:
    ibkr_trade_id: str
    account_id: str
    symbol: str
    underlying: Optional[str]
    asset_class: str          # STK | OPT | CASH | FX
    action: str               # BUY | SELL
    quantity: float
    price: float
    currency: str
    commission: float
    realized_pnl: Optional[float]
    trade_date: Optional[str]       # ISO 8601 UTC
    settle_date: Optional[str]      # ISO date
    option_expiry: Optional[str]    # ISO date
    option_strike: Optional[float]
    option_type: Optional[str]      # C | P
    option_multiplier: float
    open_close_indicator: Optional[str]   # O | C
    transaction_type: str                 # ExchTrade | BookTrade
    code: Optional[str]                   # aus TCF: O / C / A;O / A;C / C;Ep
    notes: Optional[str]                  # aus AF: A / Ep
    brokerage_order_id: Optional[str]
    # Erkannte Trade-Typen (abgeleitet aus code + notes + transactionType)
    is_assignment: bool = False     # code A;O oder A;C
    is_expired: bool = False        # code C;Ep
    is_sto: bool = False            # Sell-to-Open (code O, buySell SELL)
    is_btc: bool = False            # Buy-to-Close (code C, buySell BUY)


@dataclass
class ParsedFxTransaction:
    ibkr_trade_id: Optional[str]
    from_currency: str      # functionalCurrency (EUR)
    to_currency: str        # fxCurrency (USD)
    from_amount: float      # -proceeds wenn wir EUR→USD kaufen
    to_amount: float        # quantity in fxCurrency
    rate: float
    trade_date: Optional[str]
    description: Optional[str]


@dataclass
class ParsedCashTransaction:
    ibkr_trade_id: Optional[str]
    type: str               # dividend | interest | fee | deposit | withdrawal | withholding_tax
    amount: float
    currency: str
    description: str
    date: Optional[str]


@dataclass
class ParsedAccountSnapshot:
    snapshot_date: str      # ISO date
    net_liquidation_eur: float
    net_liquidation_usd: float  # 0 wenn nicht verfügbar
    cash_eur: float
    cash_usd: float         # 0 wenn nicht verfügbar


@dataclass
class ParseResult:
    executions: list[dict] = field(default_factory=list)
    fx_transactions: list[dict] = field(default_factory=list)
    cash_transactions: list[dict] = field(default_factory=list)
    account_snapshots: list[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


# ──────────────────────────────────────────────────────────────────────────────
# Normalisierungs-Hilfsfunktionen
# ──────────────────────────────────────────────────────────────────────────────

def _f(val: str) -> Optional[float]:
    """String → float, None bei leerem Wert."""
    if not val:
        return None
    try:
        return float(val)
    except ValueError:
        return None


def _asset_class(raw: str) -> str:
    """Normalisiert assetCategory auf STK | OPT | CASH | FX."""
    mapping = {"STK": "STK", "OPT": "OPT", "CASH": "CASH", "FX": "FX"}
    return mapping.get(raw.upper(), raw.upper())


def _action(buy_sell: str) -> str:
    """BUY/SELL normalisieren."""
    return "BUY" if buy_sell.upper() in ("BUY", "B") else "SELL"


_CASH_TYPE_MAP = {
    "Dividends": "dividend",
    "Payment In Lieu Of Dividends": "dividend",
    "Withholding Tax": "withholding_tax",
    "Broker Interest Paid": "interest",
    "Broker Interest Received": "interest",
    "Other Fees": "fee",
    "Deposits/Withdrawals": "deposit",
}


def _cash_type(raw: str) -> str:
    return _CASH_TYPE_MAP.get(raw, "fee")


# ──────────────────────────────────────────────────────────────────────────────
# Trade-Typ Erkennung (nach Merge)
# ──────────────────────────────────────────────────────────────────────────────

def _classify_trade(
    code: Optional[str],
    notes: Optional[str],
    transaction_type: str,
    buy_sell: str,
    asset_class: str,
    trade_price: float,
) -> dict:
    """
    Gibt dict mit is_assignment, is_expired, is_sto, is_btc zurück.

    Erkennungsregeln:
      - is_assignment: code in (A;O, A;C) ODER (notes=A AND transactionType=BookTrade AND assetClass=STK)
      - is_expired:    code=C;Ep ODER (notes=Ep AND transactionType=BookTrade AND price=0)
      - is_sto:        code=O AND buySell=SELL
      - is_btc:        code=C AND buySell=BUY
    """
    code_upper = (code or "").upper()
    notes_upper = (notes or "").upper()
    tx_type = transaction_type.upper()
    bs = buy_sell.upper()

    is_assignment = (
        code_upper in ("A;O", "A;C")
        or (notes_upper == "A" and tx_type == "BOOKTRADE" and asset_class == "STK")
    )
    is_expired = (
        code_upper == "C;EP"
        or (notes_upper == "EP" and tx_type == "BOOKTRADE" and trade_price == 0.0)
    )
    is_sto = code_upper == "O" and bs == "SELL"
    is_btc = code_upper == "C" and bs == "BUY"

    return {
        "is_assignment": is_assignment,
        "is_expired": is_expired,
        "is_sto": is_sto,
        "is_btc": is_btc,
    }


# ──────────────────────────────────────────────────────────────────────────────
# AF Parser
# ──────────────────────────────────────────────────────────────────────────────

def _parse_af(xml_str: str) -> tuple[dict, list, list, list]:
    """
    Parst AF-Typ XML.
    Returns: (trades_by_id, fx_transactions, cash_transactions, account_snapshots)
    """
    root = ET.fromstring(xml_str)
    assert root.attrib.get("type") == "AF", f"Erwartet type=AF, bekam: {root.attrib.get('type')}"

    trades_by_id: dict[str, dict] = {}
    fx_transactions: list[ParsedFxTransaction] = []
    cash_transactions: list[ParsedCashTransaction] = []
    account_snapshots: list[ParsedAccountSnapshot] = []

    # ── Trades ────────────────────────────────────────────────────────────────
    for trade in root.findall(".//Trade"):
        a = trade.attrib
        trade_id = a.get("tradeID", "")
        if not trade_id:
            continue

        price_raw = _f(a.get("tradePrice", "0")) or 0.0
        trades_by_id[trade_id] = {
            "ibkr_trade_id": trade_id,
            "account_id": a.get("accountId", ""),
            "symbol": a.get("symbol", "").strip(),
            "underlying": a.get("underlyingSymbol") or None,
            "asset_class": _asset_class(a.get("assetCategory", "")),
            "action": _action(a.get("buySell", "BUY")),
            "quantity": _f(a.get("quantity", "0")) or 0.0,
            "price": price_raw,
            "currency": a.get("currency", "USD"),
            "commission": _f(a.get("ibCommission", "0")) or 0.0,
            "realized_pnl": _f(a.get("fifoPnlRealized")),
            "trade_date": _parse_ibkr_datetime(a.get("dateTime", "")).isoformat()
                if _parse_ibkr_datetime(a.get("dateTime", "")) else None,
            "settle_date": _parse_ibkr_date(a.get("settleDateTarget", "")).isoformat()
                if _parse_ibkr_date(a.get("settleDateTarget", "")) else None,
            "option_expiry": _parse_ibkr_date(a.get("expiry", "")).isoformat()
                if _parse_ibkr_date(a.get("expiry", "")) else None,
            "option_strike": _f(a.get("strike")),
            "option_type": a.get("putCall") or None,
            "option_multiplier": _f(a.get("multiplier", "1")) or 1.0,
            "open_close_indicator": a.get("openCloseIndicator") or None,
            "transaction_type": a.get("transactionType", ""),
            "code": None,   # wird von TCF befüllt
            "notes": a.get("notes") or None,
            "brokerage_order_id": a.get("brokerageOrderID") or None,
            # Rohfelder für Klassifizierung (werden nach Merge entfernt)
            "_buy_sell": a.get("buySell", ""),
            "_price_raw": price_raw,
        }

    # ── FX Transactions ───────────────────────────────────────────────────────
    for fx in root.findall(".//FxTransaction"):
        a = fx.attrib
        qty = _f(a.get("quantity", "0")) or 0.0
        proceeds = _f(a.get("proceeds", "0")) or 0.0
        # quantity ist in fxCurrency (USD), proceeds in functionalCurrency (EUR)
        # rate = |qty| / |proceeds|
        rate = abs(qty) / abs(proceeds) if proceeds != 0 else 0.0
        dt = _parse_ibkr_datetime(a.get("dateTime", ""))
        fx_transactions.append(ParsedFxTransaction(
            ibkr_trade_id=a.get("tradeID") or None,
            from_currency=a.get("functionalCurrency", "EUR"),
            to_currency=a.get("fxCurrency", "USD"),
            from_amount=proceeds,
            to_amount=qty,
            rate=round(rate, 6),
            trade_date=dt.date().isoformat() if dt else None,
            description=a.get("activityDescription") or None,
        ))

    # ── Cash Transactions ─────────────────────────────────────────────────────
    for ct in root.findall(".//CashTransaction"):
        a = ct.attrib
        dt_raw = a.get("dateTime", "")
        # Manche Cash-Einträge haben "20260325;2" (kein Uhrzeit-Format) → nur Datum
        date_part = dt_raw.split(";")[0] if dt_raw else ""
        parsed_date = _parse_ibkr_date(date_part)
        cash_transactions.append(ParsedCashTransaction(
            ibkr_trade_id=a.get("tradeID") or None,
            type=_cash_type(a.get("type", "")),
            amount=_f(a.get("amount", "0")) or 0.0,
            currency=a.get("currency", "USD"),
            description=a.get("description", ""),
            date=parsed_date.isoformat() if parsed_date else None,
        ))

    # ── Account Snapshots (EquitySummaryByReportDateInBase) ───────────────────
    for eq in root.findall(".//EquitySummaryByReportDateInBase"):
        a = eq.attrib
        snap_date = _parse_ibkr_date(a.get("reportDate", ""))
        if not snap_date:
            continue
        total = _f(a.get("total", "0")) or 0.0
        cash = _f(a.get("cash", "0")) or 0.0
        account_snapshots.append(ParsedAccountSnapshot(
            snapshot_date=snap_date.isoformat(),
            net_liquidation_eur=total,   # EquitySummaryInBase ist bereits in EUR
            net_liquidation_usd=0.0,     # USD-Wert kommt ggf. aus CashReport
            cash_eur=cash,
            cash_usd=0.0,
        ))

    return trades_by_id, fx_transactions, cash_transactions, account_snapshots


# ──────────────────────────────────────────────────────────────────────────────
# TCF Parser
# ──────────────────────────────────────────────────────────────────────────────

def _parse_tcf(xml_str: str) -> dict[str, str]:
    """
    Parst TCF-Typ XML.
    Returns: {tradeID: code} — nur das code-Feld wird aus dem TCF extrahiert.
    AF ist Hauptquelle für alle anderen Felder.
    """
    root = ET.fromstring(xml_str)
    assert root.attrib.get("type") == "TCF", f"Erwartet type=TCF, bekam: {root.attrib.get('type')}"

    codes_by_id: dict[str, str] = {}
    for confirm in root.findall(".//TradeConfirm"):
        trade_id = confirm.attrib.get("tradeID", "")
        code = confirm.attrib.get("code", "")
        if trade_id and code:
            codes_by_id[trade_id] = code

    return codes_by_id


# ──────────────────────────────────────────────────────────────────────────────
# Merge & Klassifizierung
# ──────────────────────────────────────────────────────────────────────────────

def _merge_and_classify(
    trades_by_id: dict[str, dict],
    codes_by_id: dict[str, str],
) -> list[dict]:
    """
    Merged AF-Trades mit TCF-Code-Feld.
    Klassifiziert jeden Trade (is_assignment, is_expired, is_sto, is_btc).
    Entfernt interne Rohfelder.
    """
    result = []
    for trade_id, trade in trades_by_id.items():
        # TCF code-Feld einfügen (AF hat kein code-Feld)
        trade["code"] = codes_by_id.get(trade_id)

        # Klassifizierung
        flags = _classify_trade(
            code=trade["code"],
            notes=trade["notes"],
            transaction_type=trade["transaction_type"],
            buy_sell=trade.pop("_buy_sell", ""),
            asset_class=trade["asset_class"],
            trade_price=trade.pop("_price_raw", 0.0),
        )
        trade.update(flags)
        result.append(trade)

    return result


# ──────────────────────────────────────────────────────────────────────────────
# Öffentliche API
# ──────────────────────────────────────────────────────────────────────────────

def parse_activity_xml(xml_str: str) -> tuple[dict, list, list, list]:
    """Wrapper für AF-Parsing (für direkten Zugriff aus Tests)."""
    return _parse_af(xml_str)


def parse_confirms_xml(xml_str: str) -> dict[str, str]:
    """Wrapper für TCF-Parsing (für direkten Zugriff aus Tests)."""
    return _parse_tcf(xml_str)


def merge_feeds(activity_xml: str, confirms_xml: Optional[str] = None) -> ParseResult:
    """
    Hauptfunktion: Parst und merged beide XML-Quellen.

    Args:
        activity_xml:  AF-Typ XML-String (Kontoumsaetze) — required
        confirms_xml:  TCF-Typ XML-String (Handelsbestaetigung) — optional

    Returns:
        ParseResult mit executions, fx_transactions, cash_transactions, account_snapshots
    """
    # 1. AF parsen
    trades_by_id, fx_txns, cash_txns, snapshots = _parse_af(activity_xml)

    # 2. TCF parsen (optional)
    codes_by_id: dict[str, str] = {}
    if confirms_xml:
        codes_by_id = _parse_tcf(confirms_xml)

    # 3. Merge + Klassifizierung
    executions = _merge_and_classify(trades_by_id, codes_by_id)

    # 4. Statistiken
    stats = {
        "total_executions": len(executions),
        "assignments": sum(1 for e in executions if e["is_assignment"]),
        "expired": sum(1 for e in executions if e["is_expired"]),
        "sto": sum(1 for e in executions if e["is_sto"]),
        "btc": sum(1 for e in executions if e["is_btc"]),
        "fx_transactions": len(fx_txns),
        "cash_transactions": len(cash_txns),
        "account_snapshots": len(snapshots),
        "tcf_codes_merged": len(codes_by_id),
    }

    return ParseResult(
        executions=executions,
        fx_transactions=[asdict(fx) for fx in fx_txns],
        cash_transactions=[asdict(ct) for ct in cash_txns],
        account_snapshots=[asdict(s) for s in snapshots],
        stats=stats,
    )
