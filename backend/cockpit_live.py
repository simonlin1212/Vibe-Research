"""Cockpit live feeds: world indices, sector boards, stock rank, commodities.

Ported from marketingdashboard public endpoints (Tencent / Sina; Eastmoney for unique flows).
Objective snapshots only; no recommendation / scoring / prediction.
"""

from __future__ import annotations

import json
import re
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import astock
from index_catalog import INDEX_CATALOG

UA = astock.UA
em_get = astock.em_get

_HF_RE = re.compile(r"^(hf|nf)_[A-Za-z0-9]{1,12}$")
_BK_RE = re.compile(r"^BK\d{4}$", re.I)
_SINA_RANK_SORT = {"changepercent", "amount", "turnoverratio"}

WORLD_INDICES: tuple[tuple[str, str, str], ...] = INDEX_CATALOG

DEFAULT_FUTURES = "hf_XAU,hf_SI,hf_CAD,hf_CL,hf_NQ,hf_BTC"


def _num(v) -> float:
    try:
        if v is None or v == "" or v == "-":
            return 0.0
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _change(price: float, prev: float) -> float:
    return round(price - prev, 4) if prev else 0.0


def _pct(price: float, prev: float) -> float:
    if not prev:
        return 0.0
    return round((price - prev) / prev * 100, 2)


def _fetch_bytes(url: str, headers: dict | None = None, timeout: int = 12) -> bytes:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _fetch_text(url: str, *, referer: str | None = None, encoding: str = "utf-8", timeout: int = 12) -> str:
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    raw = _fetch_bytes(url, headers=headers, timeout=timeout)
    if encoding == "gbk":
        return raw.decode("gbk", errors="replace")
    try:
        return raw.decode(encoding)
    except UnicodeDecodeError:
        return raw.decode("gbk", errors="replace")


def parse_jsonp(text: str):
    """Unwrap `var t=(...)` / `jQuery(...);` JSONP payloads."""
    src = (text or "").strip()
    a = src.find("(")
    b = src.rfind(")")
    if a < 0 or b <= a:
        raise ValueError("bad jsonp")
    return json.loads(src[a + 1 : b])


def _quote_board(q: dict) -> dict:
    """OHLC / limit / valuation already on the gtimg line. Do not fetch again."""
    return {
        "open": q.get("open") or 0.0,
        "high": q.get("high") or 0.0,
        "low": q.get("low") or 0.0,
        "amplitude": q.get("amplitude") or q.get("amplitude_pct") or 0.0,
        "vol_ratio": q.get("vol_ratio") or 0.0,
        "float_mcap_yi": q.get("float_mcap_yi") or 0.0,
        "limit_up": q.get("limit_up") or 0.0,
        "limit_down": q.get("limit_down") or 0.0,
        "pe_static": q.get("pe_static") or 0.0,
    }


def parse_tencent_quote_line(line: str) -> dict | None:
    """Parse one `v_symbol="f0~f1~..."` gtimg line. Keeps full symbol as key."""
    q = astock.parse_gtimg_line(line)
    if not q:
        return None
    return {
        "symbol": q["symbol"],
        "name": q.get("name") or q["symbol"],
        "price": q.get("price") or 0.0,
        "prev": q.get("last_close") or q.get("prev") or 0.0,
        "change": q.get("change_amt") or q.get("change") or 0.0,
        "pct": q.get("change_pct") or q.get("pct") or 0.0,
        "amount": q.get("amount_wan") or q.get("amount") or 0.0,
        "turnover": q.get("turnover_pct") or q.get("turnover") or 0.0,
        "volume": q.get("volume") or 0.0,
        "bid": q.get("bid1") or q.get("bid") or 0.0,
        "ask": q.get("ask1") or q.get("ask") or 0.0,
        "bid_vol": q.get("bid1_vol") or q.get("bid_vol") or 0.0,
        "ask_vol": q.get("ask1_vol") or q.get("ask_vol") or 0.0,
        "pe_ttm": q.get("pe_ttm") or 0.0,
        "pb": q.get("pb") or 0.0,
        "mcap_yi": q.get("mcap_yi") or 0.0,
        "time": q.get("time") or "",
        "is_stale": bool(q.get("is_stale")),
        "stale_reason": q.get("stale_reason") or "",
        **_quote_board(q),
    }


def parse_tencent_quotes(text: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for line in (text or "").split(";"):
        q = parse_tencent_quote_line(line.strip())
        if q:
            out[q["symbol"]] = q
    return out


def parse_sina_hf(text: str) -> dict[str, dict]:
    """Outer-market futures: hq_str_hf_XX / v_hf_XX (Tencent-compatible layout)."""
    out: dict[str, dict] = {}
    for m in re.finditer(r'(?:hq_str_|v_)(hf_\w+)="([^"]*)"', text or ""):
        f = m.group(2).split(",")
        if len(f) < 14 or not f[0]:
            continue
        price = _num(f[0])
        prev = _num(f[7])
        out[m.group(1)] = {
            "symbol": m.group(1),
            "name": f[13] or m.group(1),
            "price": price,
            "high": _num(f[4]),
            "low": _num(f[5]),
            "open": _num(f[8]),
            "prev": prev,
            "change": _change(price, prev),
            "pct": _pct(price, prev),
            "time": f"{f[12]} {f[6]}".strip() if len(f) > 12 else "",
        }
    return out


def parse_sina_nf(text: str) -> dict[str, dict]:
    """Domestic futures hq_str_nf_XX."""
    out: dict[str, dict] = {}
    for m in re.finditer(r'hq_str_(nf_\w+)="([^"]*)"', text or ""):
        f = m.group(2).split(",")
        if len(f) < 17 or not f[0]:
            continue
        prev = _num(f[8])
        price = _num(f[5])
        if not price:
            bid, ask = _num(f[6]), _num(f[7])
            if bid and ask:
                price = round((bid + ask) / 2, 2)
            else:
                price = bid or ask or prev
        out[m.group(1)] = {
            "symbol": m.group(1),
            "name": f[0] or m.group(1),
            "price": price,
            "high": _num(f[3]),
            "low": _num(f[4]),
            "open": _num(f[2]),
            "prev": prev,
            "change": _change(price, prev),
            "pct": _pct(price, prev),
            "time": f[16] if len(f) > 16 else "",
        }
    return out


def normalize_board_code(raw: str) -> str:
    """Eastmoney f12 / BK#### -> BK####. Keep Tencent pt* bd_code as-is.

    pt01801712 and pt01801764 both contain 018017; slicing to BK8017
    would collide ~80 industry boards into a handful of codes.
    """
    s = str(raw or "").strip()
    if s.lower().startswith("pt"):
        return s
    up = s.upper()
    if _BK_RE.fullmatch(up):
        return up
    m = re.search(r"(?:BK)?(\d{3,6})", up)
    if not m:
        return s
    digits = m.group(1)
    if len(digits) >= 4:
        digits = digits[-4:]
    else:
        digits = digits.zfill(4)
    return f"BK{digits}"


def _tencent_quotes(codes: list[str]) -> dict[str, dict]:
    """Tencent batch via the shared 5s gtimg cache (same as /api/quote)."""
    if not codes:
        return {}
    rich = astock.gtimg_quotes(codes)
    out: dict[str, dict] = {}
    for key, q in rich.items():
        item = {
            "symbol": q.get("symbol") or key,
            "name": q.get("name") or key,
            "price": q.get("price") or 0.0,
            "prev": q.get("last_close") or q.get("prev") or 0.0,
            "change": q.get("change_amt") or q.get("change") or 0.0,
            "pct": q.get("change_pct") or q.get("pct") or 0.0,
            "amount": q.get("amount_wan") or q.get("amount") or 0.0,
            "turnover": q.get("turnover_pct") or q.get("turnover") or 0.0,
            "volume": q.get("volume") or 0.0,
            "bid": q.get("bid1") or q.get("bid") or 0.0,
            "ask": q.get("ask1") or q.get("ask") or 0.0,
            "bid_vol": q.get("bid1_vol") or q.get("bid_vol") or 0.0,
            "ask_vol": q.get("ask1_vol") or q.get("ask_vol") or 0.0,
            # K-line table + valuation snapshot read these; do not strip.
            "pe_ttm": q.get("pe_ttm") or 0.0,
            "pb": q.get("pb") or 0.0,
            "mcap_yi": q.get("mcap_yi") or 0.0,
            "time": q.get("time") or "",
            "is_stale": bool(q.get("is_stale")),
            "stale_reason": q.get("stale_reason") or "",
            **_quote_board(q),
        }
        out[key] = item
        sym = item["symbol"]
        if sym and sym not in out:
            out[sym] = item
    return out


_QUOTE_CODE_RE = re.compile(
    r"^(?:(?:sh|sz|bj)\d{6}|\d{6}|(?:us|hk|wh|jp|ks)[A-Za-z0-9]{2,8})$",
    re.I,
)
_EM_INDEX = {
    "jpN225": ("100.N225", "日经225"),
    "ksKOSPI": ("100.KS11", "韩国KOSPI"),
}


def _is_future_code(symbol: str) -> bool:
    s = (symbol or "").strip()
    return bool(_HF_RE.fullmatch(s))


_ASHARE_MKT_RE = re.compile(r"^(?:sh|sz|bj)\d{6}$", re.I)
_HK_QUOTE_RE = re.compile(r"^hk[A-Za-z0-9]+$", re.I)


def _quote_amount_yuan(canon: str, raw_amt: float) -> float:
    """Tencent qt field 37 is wan. Convert A-share (stock+index) and HK; US/FX stay 0."""
    if not raw_amt:
        return 0.0
    if _ASHARE_MKT_RE.fullmatch(canon) or _HK_QUOTE_RE.fullmatch(canon):
        return float(raw_amt) * 10000.0
    return 0.0


def _canon_quote_code(raw: str) -> str:
    s = (raw or "").strip()
    if not s or not _QUOTE_CODE_RE.fullmatch(s):
        return ""
    resolved = astock.resolve_symbol(s)
    if resolved:
        return resolved
    if re.fullmatch(r"(?:us|hk|wh|jp|ks)[A-Za-z0-9]{2,8}", s, re.I):
        return s
    return ""


def _quote_item(q: dict, canon: str, *, amount: float = 0.0, turnover: float = 0.0) -> dict:
    turn = turnover or q.get("turnover") or q.get("turnover_pct") or 0.0
    price = _num(q.get("price"))
    prev = _num(q.get("prev") or q.get("last_close"))
    raw_pct = q.get("pct")
    if raw_pct is None:
        raw_pct = q.get("change_pct")
    # Prefer (price-prev)/prev. Tencent f32 is sometimes still 0 after the last prints.
    # `or 0` would also swallow a real 0% and is not used here.
    if prev:
        pct = _pct(price, prev)
        change = _change(price, prev)
    else:
        pct = _num(raw_pct)
        change = _num(q.get("change") or q.get("change_amt"))
    return {
        "symbol": canon,
        "name": q.get("name") or canon,
        "price": price,
        "pct": pct,
        "change": change,
        "prev": prev,
        "amount": amount,
        "turnover": turn,
        "volume": q.get("volume") or 0.0,
        "bid": q.get("bid") or q.get("bid1") or 0.0,
        "ask": q.get("ask") or q.get("ask1") or 0.0,
        "bid_vol": q.get("bid_vol") or q.get("bid1_vol") or 0.0,
        "ask_vol": q.get("ask_vol") or q.get("ask1_vol") or 0.0,
        "pe_ttm": q.get("pe_ttm") or 0.0,
        "pb": q.get("pb") or 0.0,
        "mcap_yi": q.get("mcap_yi") or 0.0,
        "time": q.get("time") or "",
        **_quote_board(q),
    }


def quotes_map(codes: list[str]) -> dict[str, dict]:
    """Tencent equities/indices only. Max 80. Aliases 6-digit keys. Futures stay on futures_quotes."""
    wanted: list[tuple[str, str]] = []
    seen_raw: set[str] = set()
    seen_canon: set[str] = set()
    want_vix = False
    for raw in codes:
        key = (raw or "").strip()
        if not key or key in seen_raw:
            continue
        seen_raw.add(key)
        if _is_future_code(key):
            continue
        canon = _canon_quote_code(key)
        if not canon:
            continue
        if canon.lower() == "usvix" or key.lower() == "usvix":
            want_vix = True
        wanted.append((key, canon))
        seen_canon.add(canon)
        if len(seen_canon) >= 80:
            break
    out: dict[str, dict] = {}
    tencent_codes = [c for c in seen_canon if c not in _EM_INDEX]
    fetched = _tencent_quotes(tencent_codes) if tencent_codes else {}
    if seen_canon:
        for raw, canon in wanted:
            q = fetched.get(canon)
            if not q or not q.get("price"):
                continue
            raw_amt = q.get("amount") or 0.0
            item = _quote_item(
                q,
                canon,
                amount=_quote_amount_yuan(canon, raw_amt),
                turnover=q.get("turnover") or 0.0,
            )
            out[raw] = item
            out[canon] = item
            if re.fullmatch(r"(?:sh|sz|bj)\d{6}", canon):
                out[canon[2:]] = item
    if want_vix and not (out.get("usVIX") or out.get("usvix") or {}).get("price"):
        vix = _vix_from_sina()
        if vix and vix.get("price"):
            item = _quote_item(vix, "usVIX")
            out["usVIX"] = item
            out["usvix"] = item
            for raw, canon in wanted:
                if raw.lower() == "usvix" or canon.lower() == "usvix":
                    out[raw] = item
    miss = [canon for _raw, canon in wanted if canon in _EM_INDEX and not (out.get(canon) or {}).get("price")]
    if miss:
        extra = _em_index_quotes(miss)
        for raw, canon in wanted:
            q = extra.get(canon)
            if not q or not q.get("price"):
                continue
            item = _quote_item(q, canon)
            out[raw] = item
            out[canon] = item
    return out


_STALE_LOCK = threading.Lock()
_STALE_INFLIGHT: set[str] = set()


def _store_quotes(fetched: dict[str, dict], ttl: float) -> int:
    from api_common import _put

    n = 0
    for k, item in fetched.items():
        if not isinstance(item, dict) or not item.get("price"):
            continue
        _put("quote_one", k.lower(), item, ttl)
        n += 1
    return n


def _refresh_stale_quotes(codes: list[str]) -> None:
    """One Tencent pass for expired keys. 100 tabs share this flight."""
    with _STALE_LOCK:
        todo = [c for c in codes if c.lower() not in _STALE_INFLIGHT]
        for c in todo:
            _STALE_INFLIGHT.add(c.lower())
    if not todo:
        return
    try:
        _store_quotes(quotes_map(todo), astock.quote_ttl())
    finally:
        with _STALE_LOCK:
            for c in todo:
                _STALE_INFLIGHT.discard(c.lower())


def _clock_quote(key: str) -> bool:
    """Index catalog (and resolved alias) is clock-fed. Watchlist stays first-ask."""
    from api_common import is_catalog_symbol

    if is_catalog_symbol(key):
        return True
    resolved = astock.resolve_symbol(key) or ""
    return bool(resolved) and is_catalog_symbol(resolved)


def quotes_cached(codes: list[str]) -> dict[str, dict]:
    """One in-process copy. Fresh hit, else last tick, else fetch. Tabs share it."""
    from api_common import _DC_CACHE

    out: dict[str, dict] = {}
    unseen: list[str] = []
    stale: list[str] = []
    seen: set[str] = set()
    for raw in codes:
        key = (raw or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        slot = ("quote_one", key.lower())
        last = _DC_CACHE.get_last(slot)
        if isinstance(last, dict) and last.get("price"):
            out[key] = last
            if slot not in _DC_CACHE and not _clock_quote(key):
                stale.append(key)
        else:
            unseen.append(key)
    if unseen:
        fetched = quotes_map(unseen)
        _store_quotes(fetched, astock.quote_ttl())
        for k, item in fetched.items():
            if isinstance(item, dict) and item.get("price"):
                out[k] = item
    if stale:
        threading.Thread(
            target=_refresh_stale_quotes,
            args=(stale,),
            name="quote-stale",
            daemon=True,
        ).start()
    return out


def warm_hub_quotes(codes: list[str]) -> int:
    """Force-write quote_one keys used by GET /market/quotes."""
    return _store_quotes(quotes_map(codes), astock.quote_ttl())


def _vix_from_sina() -> dict | None:
    try:
        text = _fetch_text(
            "https://hq.sinajs.cn/list=hf_VX",
            referer="https://finance.sina.com.cn/futures/",
            encoding="gbk",
            timeout=6,
        )
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    parsed = parse_sina_hf(text)
    item = parsed.get("hf_VX")
    if not item or not item.get("price"):
        return None
    return {
        "symbol": "usVIX",
        "name": "恐慌指数",
        "price": item["price"],
        "prev": item["prev"],
        "change": item["change"],
        "pct": item["pct"],
        "amount": 0.0,
    }


def _em_index_quotes(codes: list[str]) -> dict[str, dict]:
    """Eastmoney ulist for catalog indices Tencent does not carry (Nikkei / KOSPI)."""
    want: list[str] = []
    by_code: dict[str, tuple[str, str]] = {}
    for c in codes:
        hit = _EM_INDEX.get(c)
        if not hit:
            continue
        secid, name = hit
        want.append(secid)
        by_code[secid.split(".", 1)[-1].upper()] = (c, name)
    if not want:
        return {}
    try:
        r = em_get(
            "https://push2.eastmoney.com/api/qt/ulist.np/get",
            params={
                "fltt": "2",
                "invt": "2",
                "secids": ",".join(want),
                "fields": "f2,f3,f4,f12,f14,f18",
            },
            headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"},
            timeout=8,
        )
        diff = ((r.json() or {}).get("data") or {}).get("diff") or []
    except Exception:
        return {}
    out: dict[str, dict] = {}
    for row in diff:
        mapped = by_code.get(str(row.get("f12") or "").upper())
        if not mapped:
            continue
        canon, name = mapped
        price = _num(row.get("f2"))
        if not price:
            continue
        prev = _num(row.get("f18"))
        out[canon] = {
            "symbol": canon,
            "name": row.get("f14") or name,
            "price": price,
            "prev": prev,
            "change": _num(row.get("f4")),
            "pct": _num(row.get("f3")),
            "amount": 0.0,
        }
    return out


def world_indices() -> list[dict]:
    """A / HK / US / JP / KR / FX key indices (Tencent; VIX Sina; JP/KR Eastmoney)."""
    codes = [c for c, _n, _r in WORLD_INDICES]
    quotes: dict[str, dict] = {}
    try:
        quotes = _tencent_quotes([c for c in codes if c not in _EM_INDEX])
    except (urllib.error.URLError, TimeoutError, OSError, UnicodeError):
        quotes = {}

    if "usVIX" not in quotes or not quotes["usVIX"].get("price"):
        vix = _vix_from_sina()
        if vix:
            quotes["usVIX"] = vix
    miss = [c for c in codes if c in _EM_INDEX and not (quotes.get(c) or {}).get("price")]
    if miss:
        quotes.update(_em_index_quotes(miss))

    out = []
    for code, label, region in WORLD_INDICES:
        q = quotes.get(code) or {}
        price = q.get("price")
        if not isinstance(price, (int, float)) or price <= 0:
            continue
        out.append({
            "symbol": code,
            "name": q.get("name") or label,
            "label": label,
            "region": region,
            "price": price,
            "change": q.get("change") or 0,
            "change_pct": q.get("pct") or 0,
            "amount": q.get("amount") or 0,
        })
    return out


def sector_boards(kind: str = "01", direction: str = "0", n: int = 30) -> list[dict]:
    """Industry (01) / concept (02) realtime board rank (Tencent)."""
    k = "02" if str(kind) == "02" else "01"
    d = "1" if str(direction) == "1" else "0"
    want = max(5, min(int(n or 30), 200))
    try:
        return _tencent_boards(k, d, want)
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, KeyError):
        return []


def _tencent_boards(kind: str, direction: str, want: int) -> list[dict]:
    url = (
        "https://ifzq.gtimg.cn/appstock/app/mktHs/rank"
        f"?l={want}&p=1&t={kind}/averatio&o={direction}"
    )
    payload = json.loads(_fetch_text(url, timeout=10))
    rows = []
    for b in payload.get("data") or []:
        if not isinstance(b, dict):
            continue
        raw = str(b.get("bd_code") or "")
        rows.append({
            "code": raw or normalize_board_code(raw),
            "raw_code": raw,
            "name": b.get("bd_name") or "",
            "price": _num(b.get("bd_zxj")),
            "change": _num(b.get("bd_zd")),
            "pct": _num(b.get("bd_zdf")),
            "lead_code": b.get("nzg_code") or "",
            "lead_name": b.get("nzg_name") or "",
            "lead_pct": _num(b.get("nzg_zdf")),
            "pct5": _num(b.get("bd_zdf5")),
            "pct20": _num(b.get("bd_zdf20")),
        })
    return rows


def parse_qq_board_rank(items: object, n: int = 20) -> list[dict]:
    """Tencent getBoardRankList rows -> board-stock fields."""
    if not isinstance(items, list):
        return []
    want = max(1, min(int(n or 20), 80))
    rows: list[dict] = []
    for s in items:
        if not isinstance(s, dict):
            continue
        raw = str(s.get("code") or "").strip()
        code6 = raw[2:] if len(raw) >= 8 and raw[:2].isalpha() else raw
        if not (code6.isdigit() and len(code6) == 6):
            continue
        price = _num(s.get("zxj"))
        if price <= 0:
            continue
        vol = _num(s.get("volume"))
        rows.append({
            "code": code6,
            "symbol": raw,
            "name": s.get("name") or "",
            "price": price,
            "pct": _num(s.get("zdf")),
            "amount": vol * 100 * price,
            "turnover": _num(s.get("hsl")),
            "main_net": None,
            "main_pct": None,
        })
        if len(rows) >= want:
            break
    return rows


def _tencent_board_stocks(raw_code: str, want: int) -> list[dict]:
    """qq getBoardRankList. Needs Tencent bd_code like pt01801712, not BK####."""
    key = (raw_code or "").strip().lower()
    if not key.startswith("pt"):
        return []
    url = (
        "https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList"
        f"?board_code={key}&sort_type=PriceRatio&direct=down&offset=0&count={want}"
    )
    payload = json.loads(
        _fetch_text(url, referer="https://stockapp.finance.qq.com/", timeout=12)
    )
    items = ((payload.get("data") or {}).get("rank_list") if isinstance(payload, dict) else None) or []
    return parse_qq_board_rank(items, want)


def _em_ulist_flow(codes: list[str]) -> dict[str, tuple[float, float]]:
    """One Eastmoney ulist batch: {code: (main_net, main_pct)}."""
    uniq: list[str] = []
    seen: set[str] = set()
    for c in codes:
        if not (isinstance(c, str) and c.isdigit() and len(c) == 6) or c in seen:
            continue
        seen.add(c)
        uniq.append(c)
    out: dict[str, tuple[float, float]] = {}
    for i in range(0, len(uniq), 50):
        chunk = uniq[i:i + 50]
        secids = ",".join(
            f"{'1' if c.startswith(('6', '9')) else '0'}.{c}" for c in chunk
        )
        params = {"secids": secids, "fields": "f12,f62,f184", "np": "1", "fltt": "2", "invt": "2"}
        items: list = []
        for host in ("push2delay.eastmoney.com", "push2.eastmoney.com"):
            try:
                r = em_get(
                    f"https://{host}/api/qt/ulist.np/get",
                    params=params,
                    headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"},
                    timeout=12,
                )
                diff = ((r.json() or {}).get("data") or {}).get("diff") or []
                if isinstance(diff, dict):
                    diff = list(diff.values())
                if diff:
                    items = diff
                    break
            except Exception:
                continue
        for it in items:
            if not isinstance(it, dict):
                continue
            code = str(it.get("f12") or "").strip()
            if not code:
                continue
            out[code] = (_num(it.get("f62")), _num(it.get("f184")))
    return out


def _attach_em_flow(rows: list[dict]) -> list[dict]:
    flow = _em_ulist_flow([str(r.get("code") or "") for r in rows])
    for r in rows:
        rec = flow.get(str(r.get("code") or ""))
        if rec:
            r["main_net"] = rec[0]
            r["main_pct"] = rec[1]
    return rows


def stock_flow_map(codes: list[str]) -> dict[str, dict]:
    """Batch main-net / main-pct. Same ulist as the reference dashboard."""
    flow = _em_ulist_flow(codes)
    out: dict[str, dict] = {}
    for c in codes:
        rec = flow.get(c)
        if rec:
            out[c] = {"main_net": rec[0], "main_pct": rec[1], "netIn": rec[0], "netRatio": rec[1]}
        else:
            out[c] = {"main_net": None, "main_pct": None, "netIn": None, "netRatio": None}
    return out


def stock_flows(codes: list[str]) -> list[dict]:
    """Reference /api/stock-flows shape: [{code, netIn, netRatio}, ...]."""
    flow = _em_ulist_flow(codes)
    rows: list[dict] = []
    for c in codes:
        rec = flow.get(c)
        if rec is None:
            continue
        rows.append({"code": c, "netIn": rec[0], "netRatio": rec[1]})
    return rows


def board_stocks(code: str, n: int = 12) -> list[dict]:
    """Board constituents by change pct (Tencent qq rank). Main-net from Eastmoney ulist."""
    raw = (code or "").strip()
    want = max(5, min(int(n or 12), 80))
    try:
        rows = _tencent_board_stocks(raw, want)
        if rows:
            try:
                _attach_em_flow(rows)
            except Exception:
                pass
            return rows
    except Exception:
        pass
    return []


def stock_rank(sort: str = "changepercent", asc: int = 0, n: int = 30) -> list[dict]:
    """A-share rank: amount / changepercent (Sina hs_a). Main-net from Eastmoney ulist."""
    key = sort if sort in _SINA_RANK_SORT else "changepercent"
    desc = 0 if int(asc or 0) == 1 else 1
    want = max(5, min(int(n or 30), 50))
    try:
        rows = _sina_rank(key, 0 if desc else 1, want) or []
    except Exception:
        return []
    if rows:
        try:
            _attach_em_flow(rows)
        except Exception:
            pass
    return rows


def parse_sina_amount_rows(arr: object, n: int = 20) -> list[dict]:
    """Sina getHQNodeData amount rows -> turnover-top fields (yuan)."""
    if not isinstance(arr, list):
        return []
    want = max(1, min(int(n or 20), 80))
    rows: list[dict] = []
    for s in arr:
        if not isinstance(s, dict):
            continue
        code = str(s.get("code") or "").strip()
        if not (code.isdigit() and len(code) == 6):
            continue
        price = _num(s.get("trade"))
        if price <= 0:
            continue
        # Sina mktcap / nmc are wan yuan; Eastmoney f20 / f21 are yuan.
        mkt = _num(s.get("mktcap"))
        nmc = _num(s.get("nmc"))
        rows.append({
            "code": code,
            "name": s.get("name") or "",
            "price": price,
            "pct": _num(s.get("changepercent")),
            "amount": _num(s.get("amount")),
            "mcap": mkt * 10000,
            "float_cap": nmc * 10000,
            "industry": "",
        })
        if len(rows) >= want:
            break
    return rows


def sina_amount_rank(n: int = 20) -> list[dict]:
    """Sina hs_a amount rank (yuan / yi-ready fields for turnover-top)."""
    fetch_n = min(80, max(int(n or 20), 20))
    url = (
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
        f"Market_Center.getHQNodeData?page=1&num={fetch_n}&sort=amount&asc=0&node=hs_a"
    )
    arr = json.loads(_fetch_text(url, referer="https://finance.sina.com.cn/", timeout=12))
    return parse_sina_amount_rows(arr, n)


def _sina_rank(sort: str, asc: int, want: int) -> list[dict]:
    fetch_n = min(80, max(want * 2, 40))
    url = (
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
        f"Market_Center.getHQNodeData?page=1&num={fetch_n}&sort={sort}&asc={asc}&node=hs_a"
    )
    arr = json.loads(_fetch_text(url, referer="https://finance.sina.com.cn/", timeout=12))
    if not isinstance(arr, list):
        return []
    rows = []
    for s in arr:
        if not isinstance(s, dict):
            continue
        price = _num(s.get("trade"))
        if price <= 0:
            continue
        rows.append({
            "symbol": s.get("symbol") or "",
            "code": s.get("code") or "",
            "name": s.get("name") or "",
            "price": price,
            "pct": _num(s.get("changepercent")),
            # Sina getHQNodeData amount is yuan, same as Eastmoney f6.
            "amount": _num(s.get("amount")),
            "turnover": _num(s.get("turnoverratio")),
        })
        if len(rows) >= want:
            break
    return rows


def _board_flow_pick(po: int, half: int) -> list[dict]:
    """One Eastmoney industry fund-flow page. po=1 inflow, po=0 outflow."""
    params = {
        "fid": "f62", "po": str(po), "pz": str(half), "pn": "1", "np": "1",
        "fltt": "2", "invt": "2", "fs": "m:90+t:2",
        "fields": "f12,f14,f62",
    }
    data: dict = {}
    for host in ("push2delay.eastmoney.com", "push2.eastmoney.com"):
        try:
            r = em_get(
                f"https://{host}/api/qt/clist/get",
                params=params,
                headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"},
                timeout=12,
            )
            data = (r.json() or {}).get("data") or {}
            if data.get("diff"):
                break
        except Exception:
            continue
    items = data.get("diff") or []
    if isinstance(items, dict):
        items = list(items.values())
    out = []
    for b in items:
        if not isinstance(b, dict):
            continue
        out.append({
            "code": normalize_board_code(str(b.get("f12") or "")),
            "name": b.get("f14") or "",
            "net_in": _num(b.get("f62")),
        })
    return out


def _peek_fflow_kline(code: str) -> list[dict]:
    """Return cached minute curve only. Do not hit Eastmoney."""
    from api_common import _DC_CACHE

    hit = _DC_CACHE.get(("board_fflow_kline", normalize_board_code(code)))
    return hit if isinstance(hit, list) else []


def board_flow_intraday(n: int = 20, curves: bool = True) -> list[dict]:
    """Industry inflow/outflow TOP, optional minute cumulative main-net.

    curves=False is 2 Eastmoney pages (ranks). curves=True adds one kline
    per board (~20 more launches). Peek cached klines on the rank path so a
    warm process can paint the butterfly without waiting.
    """
    half = max(3, min(15, (int(n or 20)) // 2))
    with ThreadPoolExecutor(max_workers=2) as pool:
        fu = pool.submit(_board_flow_pick, 1, half)
        fd = pool.submit(_board_flow_pick, 0, half)
        ups, downs = fu.result(), fd.result()
    seen = {u["code"] for u in ups}
    boards = ups + [d for d in downs if d["code"] not in seen]
    if not curves:
        return [{**b, "points": _peek_fflow_kline(b["code"])} for b in boards]
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(boards)))) as pool:
        futs = [pool.submit(_board_fflow_kline_cached, b["code"]) for b in boards]
        pts = [fut.result() for fut in futs]
    return [{**b, "points": p} for b, p in zip(boards, pts)]


def _board_fflow_kline_cached(code: str) -> list[dict]:
    """Per-board minute curve. Same TTL key as a later full-list refresh."""
    from api_common import BOARD_FLOW_TTL, _cached

    bk = normalize_board_code(code)
    return _cached(
        "board_fflow_kline",
        bk,
        BOARD_FLOW_TTL,
        lambda: _board_fflow_kline(bk),
        valid=lambda d: isinstance(d, list) and len(d) > 0,
    )


def _board_fflow_kline(code: str) -> list[dict]:
    bk = normalize_board_code(code)
    if not _BK_RE.fullmatch(bk):
        return []
    params = {
        "secid": f"90.{bk}",
        "klt": "1",
        "lmt": "0",
        "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52",
    }
    for host in ("push2delay.eastmoney.com", "push2.eastmoney.com"):
        try:
            r = em_get(
                f"https://{host}/api/qt/stock/fflow/kline/get",
                params=params,
                headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"},
                timeout=12,
            )
            kl = ((r.json() or {}).get("data") or {}).get("klines") or []
            pts = []
            for s in kl:
                f = str(s).split(",")
                if len(f) < 2:
                    continue
                t = f[0][11:16] if len(f[0]) >= 16 else f[0]
                pts.append({"t": t, "v": _num(f[1])})
            return pts
        except Exception:
            continue
    return []


def _sanitize_future_codes(raw: str) -> list[str]:
    codes = []
    for part in str(raw or DEFAULT_FUTURES).split(","):
        s = part.strip()
        if _HF_RE.fullmatch(s):
            codes.append(s)
        if len(codes) >= 20:
            break
    return codes


def futures_quotes(raw_list: str | None = None) -> dict[str, dict]:
    """Gold / silver / copper / oil / NQ / BTC CFD snapshot."""
    codes = _sanitize_future_codes(raw_list or DEFAULT_FUTURES)
    out: dict[str, dict] = {}
    hf = [c for c in codes if c.startswith("hf_")]
    nf = [c for c in codes if c.startswith("nf_")]
    if hf:
        parsed: dict[str, dict] = {}
        try:
            raw = _fetch_text(
                "https://qt.gtimg.cn/q=" + ",".join(hf),
                encoding="gbk",
                timeout=10,
            )
            parsed = parse_sina_hf(raw.replace("v_", "hq_str_"))
        except (urllib.error.URLError, TimeoutError, OSError):
            parsed = {}
        missing = [c for c in hf if c not in parsed]
        if missing:
            try:
                text = _fetch_text(
                    "https://hq.sinajs.cn/list=" + ",".join(missing),
                    referer="https://finance.sina.com.cn/futures/quotes/CL.shtml",
                    encoding="gbk",
                    timeout=10,
                )
                parsed.update(parse_sina_hf(text))
            except (urllib.error.URLError, TimeoutError, OSError):
                pass
        out.update(parsed)
    if nf:
        try:
            text = _fetch_text(
                "https://hq.sinajs.cn/list=" + ",".join(nf),
                referer="https://finance.sina.com.cn/futures/quotes/AU0.shtml",
                encoding="gbk",
                timeout=10,
            )
            out.update(parse_sina_nf(text))
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
    return out


def future_minute(code: str) -> dict:
    """Intraday minute series for hf_ / nf_."""
    c = (code or "").strip()
    if c.startswith("hf_") and _HF_RE.fullmatch(c):
        return _hf_minute(c)
    if c.startswith("nf_") and _HF_RE.fullmatch(c):
        return _nf_minute(c)
    raise ValueError(f"bad future code: {c}")


def _hf_minute(code: str) -> dict:
    symbol = code[3:]
    text = _fetch_text(
        "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/"
        f"GlobalFuturesService.getGlobalFuturesMinLine?symbol={symbol}",
        referer=f"https://finance.sina.com.cn/futures/quotes/{symbol}.shtml",
        timeout=12,
    )
    arr = (parse_jsonp(text) or {}).get("minLine_1d") or []
    pts = []
    for f in arr:
        if not isinstance(f, (list, tuple)) or len(f) < 2:
            continue
        if ":" not in str(f[0]):
            continue
        pts.append({"t": str(f[0]), "p": _num(f[1])})
    quotes = futures_quotes(code)
    return {"code": code, "prec": (quotes.get(code) or {}).get("prev") or 0, "points": pts}


def _nf_minute(code: str) -> dict:
    symbol = code[3:]
    text = _fetch_text(
        "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/"
        f"InnerFuturesNewService.getMinLine?symbol={symbol}",
        referer=f"https://finance.sina.com.cn/futures/quotes/{symbol}.shtml",
        timeout=12,
    )
    arr = parse_jsonp(text) or []
    pts = []
    for f in arr:
        if not isinstance(f, (list, tuple)) or len(f) < 2:
            continue
        pts.append({"t": str(f[0]), "p": _num(f[1])})
    quotes = futures_quotes(code)
    return {"code": code, "prec": (quotes.get(code) or {}).get("prev") or 0, "points": pts}


def future_minutes(codes: list[str]) -> dict[str, dict | None]:
    """Batch future minutes. Parallel like marketingdashboard /api/batch-fmin."""
    uniq: list[str] = []
    seen: set[str] = set()
    for raw in codes[:12]:
        c = (raw or "").strip()
        if not c or c in seen:
            continue
        seen.add(c)
        uniq.append(c)
    if not uniq:
        return {}

    def _one(c: str) -> tuple[str, dict | None]:
        try:
            return c, future_minute(c)
        except Exception:
            return c, None

    out: dict[str, dict | None] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(uniq))) as pool:
        for c, data in pool.map(_one, uniq):
            out[c] = data
    return out


def future_minutes_filled(data) -> bool:
    """True if one series has enough points. Empty-points dict must not stick."""
    if not isinstance(data, dict):
        return False
    return any(
        isinstance(row, dict) and len(row.get("points") or []) >= 1
        for row in data.values()
    )


def future_daily(code: str, n: int = 400) -> dict:
    """Sina daily OHLC for hf_ (global) / nf_ (domestic)."""
    from urllib.parse import quote

    c = (code or "").strip()
    if not _HF_RE.fullmatch(c):
        raise ValueError(f"bad future code: {c}")
    is_global = c.startswith("hf_")
    symbol = c[3:]
    api = (
        f"GlobalFuturesService.getGlobalFuturesDailyKLine?symbol={quote(symbol)}"
        if is_global
        else f"InnerFuturesNewService.getDailyKLine?symbol={quote(symbol)}"
    )
    text = _fetch_text(
        f"https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/{api}",
        referer=f"https://finance.sina.com.cn/futures/quotes/{symbol}.shtml",
        timeout=15,
    )
    arr = parse_jsonp(text) or []
    if not isinstance(arr, list):
        arr = []
    pts = []
    for k in arr:
        if not isinstance(k, dict):
            continue
        t = k.get("d") or k.get("date")
        close = _num(k.get("c") if k.get("c") is not None else k.get("close"))
        if not t or not close:
            continue
        pts.append({
            "t": str(t)[:10],
            "o": _num(k.get("o") if k.get("o") is not None else k.get("open")),
            "h": _num(k.get("h") if k.get("h") is not None else k.get("high")),
            "l": _num(k.get("l") if k.get("l") is not None else k.get("low")),
            "c": close,
            "v": _num(k.get("v") if k.get("v") is not None else k.get("volume")),
        })
    want = max(20, min(int(n or 400), 2000))
    return {"code": c, "source": "sina", "points": pts[-want:]}


def stock_boards(code: str) -> dict:
    """Eastmoney industry / area / concepts for one A-share (f127/f128/f129)."""
    raw = (code or "").strip().lower()
    m = re.fullmatch(r"(?:(sh|sz|bj))?(\d{6})", raw)
    if not m:
        raise ValueError("code must be 6 digits or sh/sz/bj+6")
    prefix, digits = m.group(1), m.group(2)
    if not prefix:
        prefix = "sh" if digits.startswith(("5", "6", "9")) else "sz"
    market = 1 if prefix == "sh" else 0
    params = {"secid": f"{market}.{digits}", "fields": "f57,f58,f127,f128,f129"}
    d: dict = {}
    for host in ("push2delay.eastmoney.com", "push2.eastmoney.com"):
        try:
            r = em_get(
                f"https://{host}/api/qt/stock/get",
                params=params,
                headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"},
                timeout=10,
            )
            d = (r.json() or {}).get("data") or {}
            if d:
                break
        except Exception:
            continue
    if not d:
        raise RuntimeError("empty stock boards")
    concepts = [x for x in str(d.get("f129") or "").split(",") if x]
    return {
        "code": f"{prefix}{digits}",
        "name": d.get("f58") or "",
        "industry": d.get("f127") or "",
        "area": d.get("f128") or "",
        "concepts": concepts,
        "source": "eastmoney",
    }


def stock_boards_map(codes: list[str], fetch=None) -> dict[str, dict]:
    """Industry / concept tags for up to 12 A-share codes. Failures are skipped."""
    get_one = fetch or stock_boards
    out: dict[str, dict] = {}
    seen: set[str] = set()
    n = 0
    for raw in codes:
        key = (raw or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        if n >= 12:
            break
        try:
            row = get_one(key)
        except (ValueError, RuntimeError, OSError, TypeError):
            continue
        n += 1
        out[key] = row
        canon = str(row.get("code") or "")
        if canon:
            out[canon] = row
            digits = re.sub(r"^(?:sh|sz|bj)", "", canon, flags=re.I)
            if digits:
                out[digits] = row
    return out
