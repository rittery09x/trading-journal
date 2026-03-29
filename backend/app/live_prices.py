"""
Live-Kurse via yfinance
=======================
Stellt Echtzeitkurse für Aktien und Optionen bereit.

Kernfunktionen:
  ibkr_to_occ_symbol()  — IBKR-Felder → OCC Options-Symbol
  get_live_price()       — Kurs via yfinance mit 15-Min-Cache
  get_live_prices_bulk() — Batch-Abruf für mehrere Positionen

OCC-Format:
  [Underlying][YY][MM][DD][C/P][Strike * 1000 als 8-stellige Zahl]
  Beispiel: NVDA, 2026-04-02, C, 187.5
           → "NVDA260402C00187500"  (187500 → auf 8 Stellen padden)

Fehlerbehandlung:
  - Verfallene/nicht gefundene Optionen: price=0.0, status="expired"
  - Netzwerkfehler: price=None, status="error"
  - Nie ungefangene Exceptions aus yfinance-Aufrufen
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Cache (in-memory, 15 Minuten TTL)
# ──────────────────────────────────────────────────────────────────────────────

CACHE_TTL_SECONDS = 15 * 60  # 15 Minuten

_cache: dict[str, tuple[datetime, dict]] = {}  # symbol → (timestamp, result)


def _cache_get(key: str) -> Optional[dict]:
    if key not in _cache:
        return None
    ts, value = _cache[key]
    if (datetime.now(timezone.utc) - ts).total_seconds() > CACHE_TTL_SECONDS:
        del _cache[key]
        return None
    return value


def _cache_set(key: str, value: dict) -> None:
    _cache[key] = (datetime.now(timezone.utc), value)


def cache_clear() -> None:
    """Leert den gesamten Cache (für Tests)."""
    _cache.clear()


def cache_stats() -> dict:
    """Gibt Cache-Statistiken zurück."""
    now = datetime.now(timezone.utc)
    valid = sum(
        1 for ts, _ in _cache.values()
        if (now - ts).total_seconds() <= CACHE_TTL_SECONDS
    )
    return {"total_entries": len(_cache), "valid_entries": valid}


# ──────────────────────────────────────────────────────────────────────────────
# OCC Symbol-Konverter
# ──────────────────────────────────────────────────────────────────────────────

def ibkr_to_occ_symbol(
    underlying: str,
    expiry: str,       # ISO-Format: "2026-04-02" oder IBKR: "20260402"
    option_type: str,  # "C" oder "P"
    strike: float,
) -> str:
    """
    Konvertiert IBKR-Felder in ein OCC-Options-Symbol.

    OCC-Format: [Underlying][YY][MM][DD][C/P][8-stellige Strike-Zahl]
    Strike-Encoding: strike * 1000, als Integer, 0-padded auf 8 Stellen.

    Beispiele:
      NVDA, 2026-04-02, C, 187.5  → "NVDA260402C00187500"
      AAPL, 2026-04-02, P, 242.5  → "AAPL260402P00242500"
      FISV, 2026-04-17, C, 60.0   → "FISV260417C00060000"
      GIS,  2026-04-17, P, 40.0   → "GIS260417P00040000"

    Args:
        underlying: Basiswert-Symbol (z.B. "NVDA"), wird trimmed/uppercase
        expiry:     Verfallsdatum als ISO-String "2026-04-02" oder "20260402"
        option_type: "C" für Call, "P" für Put (case-insensitive)
        strike:     Ausübungspreis als float

    Returns:
        OCC-Symbol-String (z.B. "NVDA260402C00187500")

    Raises:
        ValueError: bei ungültigem Datumsformat oder unbekanntem option_type
    """
    # Underlying: trim whitespace, uppercase
    sym = underlying.strip().upper()

    # Expiry: normalisieren auf YYMMDD
    expiry_clean = expiry.strip().replace("-", "")
    if len(expiry_clean) == 8:          # YYYYMMDD → YYMMDD
        yy = expiry_clean[2:4]
        mm = expiry_clean[4:6]
        dd = expiry_clean[6:8]
    elif len(expiry_clean) == 6:        # YYMMDD direkt
        yy = expiry_clean[0:2]
        mm = expiry_clean[2:4]
        dd = expiry_clean[4:6]
    else:
        raise ValueError(f"Ungültiges Datumsformat: {expiry!r}")

    # Option-Typ
    ot = option_type.strip().upper()
    if ot not in ("C", "P"):
        raise ValueError(f"Ungültiger option_type: {option_type!r}. Erwartet 'C' oder 'P'.")

    # Strike → Integer (Cent-Preis * 10), 8-stellig 0-padded
    # OCC: strike * 1000, als integer, dann auf 8 Stellen padden
    strike_int = round(strike * 1000)
    strike_str = str(strike_int).zfill(8)

    return f"{sym}{yy}{mm}{dd}{ot}{strike_str}"


def occ_to_components(occ_symbol: str) -> dict:
    """
    Parst ein OCC-Symbol zurück in seine Bestandteile.
    Nützlich für Debugging und Tests.

    Returns: {underlying, expiry_iso, option_type, strike}
    """
    # Pattern: 1+ Buchstaben, 6 Ziffern (YYMMDD), C/P, 8 Ziffern
    m = re.match(r"^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$", occ_symbol)
    if not m:
        raise ValueError(f"Kein gültiges OCC-Symbol: {occ_symbol!r}")
    underlying, yy, mm, dd, ot, strike_str = m.groups()
    return {
        "underlying": underlying,
        "expiry_iso": f"20{yy}-{mm}-{dd}",
        "option_type": ot,
        "strike": int(strike_str) / 1000,
    }


# ──────────────────────────────────────────────────────────────────────────────
# yfinance Abruf
# ──────────────────────────────────────────────────────────────────────────────

def _fetch_stock_price(symbol: str) -> dict:
    """Aktien-Kurs via yfinance. Gibt immer ein dict zurück."""
    try:
        import yfinance as yf
        ticker = yf.Ticker(symbol)
        info = ticker.fast_info
        price = getattr(info, "last_price", None)
        if price is None:
            # Fallback: history der letzten 1 Tag
            hist = ticker.history(period="1d", auto_adjust=True)
            if not hist.empty:
                price = float(hist["Close"].iloc[-1])
        if price is None or price == 0.0:
            return {"price": None, "status": "not_found", "symbol": symbol}
        return {
            "price": round(float(price), 4),
            "status": "ok",
            "symbol": symbol,
            "currency": getattr(info, "currency", "USD"),
        }
    except Exception as exc:
        logger.warning("yfinance STK fetch failed for %s: %s", symbol, exc)
        return {"price": None, "status": "error", "symbol": symbol, "error": str(exc)}


def _fetch_option_price(occ_symbol: str, underlying: str) -> dict:
    """
    Options-Kurs via yfinance über OCC-Symbol.

    yfinance erwartet das OCC-Symbol direkt als Ticker
    (z.B. "NVDA260402C00187500").

    Bei nicht gefundenem Symbol (verfallene Option, ungültige Expiry):
    → price=0.0, status="expired" (nie Exception)
    """
    try:
        import yfinance as yf
        ticker = yf.Ticker(occ_symbol)
        hist = ticker.history(period="1d", auto_adjust=False)
        if hist.empty:
            # Kein Verlaufsdaten → versuche info
            try:
                info = ticker.fast_info
                price = getattr(info, "last_price", None)
                if price and price > 0:
                    return {
                        "price": round(float(price), 4),
                        "status": "ok",
                        "symbol": occ_symbol,
                        "underlying": underlying,
                    }
            except Exception:
                pass
            # Wirklich nicht gefunden → als expired behandeln
            logger.info("Option nicht gefunden (evtl. verfallen): %s", occ_symbol)
            return {
                "price": 0.0,
                "status": "expired",
                "symbol": occ_symbol,
                "underlying": underlying,
            }
        price = float(hist["Close"].iloc[-1])
        if price == 0.0:
            return {
                "price": 0.0,
                "status": "expired",
                "symbol": occ_symbol,
                "underlying": underlying,
            }
        return {
            "price": round(price, 4),
            "status": "ok",
            "symbol": occ_symbol,
            "underlying": underlying,
        }
    except Exception as exc:
        logger.warning("yfinance OPT fetch failed for %s: %s", occ_symbol, exc)
        # Bei jeder Exception: graceful fallback, nie crash
        return {
            "price": 0.0,
            "status": "expired",
            "symbol": occ_symbol,
            "underlying": underlying,
            "error": str(exc),
        }


# ──────────────────────────────────────────────────────────────────────────────
# Öffentliche API
# ──────────────────────────────────────────────────────────────────────────────

def get_live_price(
    symbol: str,
    asset_class: str,
    underlying: Optional[str] = None,
    expiry: Optional[str] = None,
    option_type: Optional[str] = None,
    strike: Optional[float] = None,
) -> dict:
    """
    Gibt den aktuellen Kurs einer Position zurück.

    Args:
        symbol:       IBKR-Symbol (z.B. "NVDA  260402C00187500" oder "NVDA")
        asset_class:  "STK" oder "OPT"
        underlying:   Basiswert (nur für OPT, z.B. "NVDA")
        expiry:       ISO-Datum "2026-04-02" (nur für OPT)
        option_type:  "C" oder "P" (nur für OPT)
        strike:       Ausübungspreis float (nur für OPT)

    Returns:
        {
          "price":      float | None,
          "status":     "ok" | "expired" | "not_found" | "error",
          "symbol":     str,            # OCC-Symbol für Optionen
          "occ_symbol": str | None,     # gesetztes OCC-Symbol
          "cached":     bool,
        }

    Fehler-Garantie: Wirft nie eine Exception. Bei Problemen immer dict mit
    status != "ok".
    """
    asset_class = asset_class.upper()

    # OCC-Symbol berechnen (für Optionen)
    occ_symbol: Optional[str] = None
    cache_key: str

    if asset_class == "OPT":
        if not all([underlying, expiry, option_type, strike is not None]):
            return {
                "price": None,
                "status": "error",
                "symbol": symbol,
                "occ_symbol": None,
                "cached": False,
                "error": "Fehlende Parameter für OPT: underlying, expiry, option_type, strike",
            }
        try:
            occ_symbol = ibkr_to_occ_symbol(
                underlying=underlying,
                expiry=expiry,
                option_type=option_type,
                strike=strike,
            )
        except ValueError as exc:
            return {
                "price": None,
                "status": "error",
                "symbol": symbol,
                "occ_symbol": None,
                "cached": False,
                "error": str(exc),
            }
        cache_key = occ_symbol
    else:
        cache_key = underlying or symbol.strip().split()[0]

    # Cache prüfen
    cached = _cache_get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    # Kurs abrufen
    if asset_class == "OPT":
        result = _fetch_option_price(occ_symbol, underlying)
    else:
        result = _fetch_stock_price(cache_key)

    result["occ_symbol"] = occ_symbol
    result["cached"] = False

    # Nur bei Erfolg cachen (keine Errors)
    if result.get("status") in ("ok", "expired"):
        _cache_set(cache_key, result)

    return result


def get_live_prices_bulk(positions: list[dict]) -> list[dict]:
    """
    Batch-Abruf für mehrere Positionen.

    Jede Position ist ein dict mit den Feldern von get_live_price().
    Gibt eine Liste von Ergebnissen in derselben Reihenfolge zurück.

    Fehler in einzelnen Positionen werden isoliert — eine fehlgeschlagene
    Position stoppt nicht die anderen.
    """
    results = []
    for pos in positions:
        try:
            result = get_live_price(
                symbol=pos.get("symbol", ""),
                asset_class=pos.get("asset_class", "STK"),
                underlying=pos.get("underlying"),
                expiry=pos.get("expiry"),
                option_type=pos.get("option_type"),
                strike=pos.get("strike"),
            )
        except Exception as exc:
            logger.error("Unerwarteter Fehler bei get_live_price: %s", exc)
            result = {
                "price": None,
                "status": "error",
                "symbol": pos.get("symbol", ""),
                "occ_symbol": None,
                "cached": False,
                "error": str(exc),
            }
        results.append(result)
    return results
