"""Event-page hot ranks. SoPilot tweets / NewsNow / REBANG / AIHOT.

One cache family (event_rank). Not review warmup, not quote hub, not telegraph.
"""
from __future__ import annotations

import html as html_lib
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable
from urllib.parse import unquote

import astock
import requests

log = logging.getLogger("event_rank")

SRC_SOPILOT = "https://sopilot.net/zh/rank/tweets"
SRC_NEWSNOW = "https://newsnow.busiyi.world/"
SRC_REBANG = "https://top.open2hub.com/"
REBANG_FIN = "https://top.open2hub.com/channel/finance"
SRC_AIHOT = "https://aihot.virxact.com/all"
SRC_AIHOT_TOPICS = "https://aihot.virxact.com/topics"
AIHOT_ITEMS = "https://aihot.virxact.com/api/v1/items"
AIHOT_HOT = "https://aihot.virxact.com/api/v1/hot-topics"
AIHOT_DAILY = "https://aihot.virxact.com/api/v1/dailies/latest"

RB_SKIP = frozenset({"雪球"})

# Finance-first. Skip sources that 500 on the public host.
NN_SOURCES: tuple[tuple[str, str], ...] = (
    ("cls-hot", "财联社"),
    ("wallstreetcn", "华尔街见闻"),
    ("jin10", "金十"),
    ("gelonghui", "格隆汇"),
    ("weibo", "微博"),
    ("zhihu", "知乎"),
)

Fetch = Callable[[], Any]

_TAG = re.compile(r"<[^>]+>")
_RANK = re.compile(r'<span class="flex h-8 w-8 shrink-0[^"]*">(\d+)</span>')
_HANDLE = re.compile(r"@<!-- -->([^<]+)")
_NAME = re.compile(
    r'href="https://x\.com/[^"/?]+"[^>]*>\s*(.*?)<span class="font-normal',
    re.S,
)
_AGE = re.compile(r">(\d+\s*[分小时天]+前|刚刚)<")
_METRIC = re.compile(r">([^<]*?)\s*曝光(/小时)?</span>")
_STATUS = re.compile(
    r'href="(https://x\.com/[^"/]+/status/\d+)"[^>]*>([^<]{2,})</a>',
)
_EYE = re.compile(r"lucide-eye.*?</svg>\s*([^<]+)", re.S)
_HEART = re.compile(r"lucide-heart.*?</svg>\s*([^<]+)", re.S)
_RB_TITLE = re.compile(r'<h3 class="platform-title">([^<]+)</h3>')
_RB_TIME = re.compile(r'<p class="platform-time">([^<]*)</p>')
_RB_FILTER = re.compile(r'data-filter="([^"]+)"')
_RB_ITEM = re.compile(
    r'<a class="list-item-link"[^>]*href="([^"]+)"[^>]*>'
    r'\s*<span class="list-number">(\d+)</span>'
    r'\s*<span class="list-text">(.*?)</span>',
    re.S,
)
_AH_H2 = re.compile(r"<h2[^>]*>(.*?)</h2>", re.S)
_AH_TOPIC = re.compile(
    r'<a class="topics-grid-card"[^>]*href="(/topics/[^"]+)"[^>]*>'
    r'\s*<span class="topics-grid-name">([^<]+)</span>'
    r'.*?<span class="topics-grid-count">查看\s*(?:<!-- -->)?([\d,]+)',
    re.S,
)


def _plain(raw: str) -> str:
    return html_lib.unescape(_TAG.sub("", raw or "")).strip()


def _get(url: str) -> str:
    r = requests.get(
        url,
        headers={"User-Agent": astock.UA, "Referer": url, "Accept-Language": "zh-CN,zh;q=0.9"},
        timeout=15,
    )
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return r.text


def _get_json(url: str, *, referer: str = SRC_NEWSNOW) -> Any:
    r = requests.get(
        url,
        headers={
            "User-Agent": astock.UA,
            "Referer": referer,
            "Accept": "application/json",
        },
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def parse_sopilot_list(html: str) -> list[dict[str, Any]]:
    """Rising or hot tweet cards from one SoPilot HTML slice."""
    parts = _RANK.split(html or "")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i in range(1, len(parts), 2):
        chunk = parts[i + 1] if i + 1 < len(parts) else ""
        st = _STATUS.search(chunk)
        if not st:
            continue
        url, text = st.group(1), _plain(st.group(2))
        if not text or url in seen:
            continue
        seen.add(url)
        handle = ""
        hm = _HANDLE.search(chunk)
        if hm:
            handle = hm.group(1).strip()
        name = ""
        nm = _NAME.search(chunk)
        if nm:
            name = _plain(nm.group(1))
        age = ""
        am = _AGE.search(chunk)
        if am:
            age = am.group(1).strip()
        metric = ""
        mm = _METRIC.search(chunk)
        if mm:
            unit = "/时" if mm.group(2) else ""
            metric = f"{mm.group(1).strip()}{unit}".strip()
        views = ""
        ev = _EYE.search(chunk)
        if ev:
            views = ev.group(1).strip()
        likes = ""
        ht = _HEART.search(chunk)
        if ht:
            likes = ht.group(1).strip()
        extra = " ".join(x for x in (age, metric, views) if x)
        out.append({
            "rank": int(parts[i]),
            "title": text,
            "url": url,
            "name": name,
            "handle": handle,
            "age": age,
            "metric": metric,
            "views": views,
            "likes": likes,
            "extra": extra,
        })
    return out


def parse_sopilot(html: str) -> dict[str, Any]:
    """Split 飙升 / 最热. Same page as sopilot.net/zh/rank/tweets."""
    text = html or ""
    cut = text.find("最热曝光榜")
    rising_html = text[:cut] if cut >= 0 else text
    hot_html = text[cut:] if cut >= 0 else ""
    start = rising_html.find("飙升起爆榜")
    if start >= 0:
        rising_html = rising_html[start:]
    return {
        "src": SRC_SOPILOT,
        "rising": parse_sopilot_list(rising_html),
        "hot": parse_sopilot_list(hot_html),
    }


def sopilot_ok(data: Any) -> bool:
    return (
        isinstance(data, dict)
        and (isinstance(data.get("rising"), list) and bool(data["rising"])
             or isinstance(data.get("hot"), list) and bool(data["hot"]))
    )


def parse_newsnow_items(raw: Any) -> list[dict[str, Any]]:
    items = []
    if isinstance(raw, dict):
        items = raw.get("items") or []
    elif isinstance(raw, list):
        items = raw
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, it in enumerate(items, 1):
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()
        url = str(it.get("url") or it.get("mobileUrl") or "").strip()
        if not title:
            continue
        key = url or title
        if key in seen:
            continue
        seen.add(key)
        extra = ""
        extra_raw = it.get("extra")
        if isinstance(extra_raw, dict):
            extra = str(extra_raw.get("info") or extra_raw.get("hover") or "").strip()
        out.append({"rank": i, "title": title, "url": url, "extra": extra})
    return out


def parse_newsnow_bundle(raw: dict[str, Any]) -> dict[str, Any]:
    tabs: list[dict[str, Any]] = []
    blob = raw if isinstance(raw, dict) else {}
    for sid, name in NN_SOURCES:
        items = parse_newsnow_items(blob.get(sid))
        tabs.append({"id": sid, "name": name, "items": items})
    return {"src": SRC_NEWSNOW, "tabs": tabs}


def newsnow_ok(data: Any) -> bool:
    if not isinstance(data, dict) or not isinstance(data.get("tabs"), list):
        return False
    return any(isinstance(t, dict) and t.get("items") for t in data["tabs"])


def _slug(name: str, hint: str) -> str:
    raw = f"{name}-{hint}" if hint else name
    return re.sub(r"\s+", "", raw)


def parse_rebang(html: str) -> list[dict[str, Any]]:
    """Homepage or channel HTML: one tab per platform card."""
    text = html or ""
    marks = list(_RB_TITLE.finditer(text))
    out: list[dict[str, Any]] = []
    for i, m in enumerate(marks):
        name = _plain(m.group(1))
        if not name or name in RB_SKIP:
            continue
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[m.start():end]
        head = text[max(0, m.start() - 500):m.start()]
        cat = ""
        fm = _RB_FILTER.search(head)
        if fm:
            cat = _plain(fm.group(1))
        hint = ""
        tm = _RB_TIME.search(body)
        if tm:
            hint = _plain(tm.group(1))
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for href, rank, title in _RB_ITEM.findall(body):
            title = _plain(title)
            url = unquote(html_lib.unescape(href or "")).strip()
            if not title:
                continue
            key = url or title
            if key in seen:
                continue
            seen.add(key)
            items.append({"rank": int(rank), "title": title, "url": url, "extra": ""})
        if not items:
            continue
        out.append({
            "id": _slug(name, hint),
            "name": name,
            "hint": hint,
            "cat": cat,
            "items": items,
        })
    return out


def parse_rebang_pages(pages: list[str]) -> list[dict[str, Any]]:
    tabs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for html in pages:
        for tab in parse_rebang(html):
            key = tab["id"]
            if key in seen:
                continue
            seen.add(key)
            tabs.append(tab)
    counts: dict[str, int] = {}
    for tab in tabs:
        counts[tab["name"]] = counts.get(tab["name"], 0) + 1
    for tab in tabs:
        if counts[tab["name"]] > 1 and tab.get("hint"):
            bit = str(tab["hint"]).split("-")[-1].strip()
            if bit:
                tab["name"] = f"{tab['name']}·{bit}"
    return tabs


def parse_rebang_board(pages: list[str]) -> dict[str, Any]:
    return {"src": SRC_REBANG, "tabs": parse_rebang_pages(pages)}


def rebang_ok(data: Any) -> bool:
    if not isinstance(data, dict) or not isinstance(data.get("tabs"), list):
        return False
    return any(isinstance(t, dict) and t.get("items") for t in data["tabs"])


def sopilot(fetch: Fetch | None = None) -> dict[str, Any]:
    return parse_sopilot((fetch or (lambda: _get(SRC_SOPILOT)))())


def _live_newsnow() -> dict[str, Any]:
    out: dict[str, Any] = {}

    def pull(sid: str) -> tuple[str, Any]:
        try:
            return sid, _get_json(f"{SRC_NEWSNOW.rstrip('/')}/api/s?id={sid}")
        except Exception as e:
            log.warning("newsnow %s failed: %s", sid, e)
            return sid, None

    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = [pool.submit(pull, sid) for sid, _ in NN_SOURCES]
        for fut in futs:
            sid, data = fut.result()
            out[sid] = data
    return out


def newsnow(fetch: Fetch | None = None) -> dict[str, Any]:
    return parse_newsnow_bundle((fetch or _live_newsnow)())


def _live_rebang() -> list[str]:
    pages = ["", ""]

    def pull(i: int, url: str) -> None:
        try:
            pages[i] = _get(url)
        except Exception as e:
            log.warning("rebang %s failed: %s", url, e)

    with ThreadPoolExecutor(max_workers=2) as pool:
        pool.submit(pull, 0, SRC_REBANG)
        pool.submit(pull, 1, REBANG_FIN)
    return pages


def rebang(fetch: Fetch | None = None) -> dict[str, Any]:
    raw = (fetch or _live_rebang)()
    if isinstance(raw, str):
        raw = [raw]
    return parse_rebang_board(list(raw or []))


def _src_name(raw: Any) -> str:
    if isinstance(raw, dict):
        return str(raw.get("name") or "").strip()
    return str(raw or "").strip()


def _item_url(it: dict[str, Any]) -> str:
    raw = it.get("links")
    links = raw if isinstance(raw, dict) else {}
    return str(
        it.get("url")
        or links.get("original")
        or links.get("aihot")
        or it.get("permalink")
        or ""
    ).strip()


def parse_aihot_items(raw: Any) -> list[dict[str, Any]]:
    items = []
    if isinstance(raw, dict):
        items = raw.get("items") or []
    elif isinstance(raw, list):
        items = raw
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, it in enumerate(items, 1):
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()
        url = _item_url(it)
        if not title:
            continue
        key = url or title
        if key in seen:
            continue
        seen.add(key)
        src = _src_name(it.get("source"))
        score = it.get("score")
        nsrc = it.get("sourceCount")
        rank = it.get("rank")
        bits = [src]
        if score is not None:
            bits.append(str(score))
        elif nsrc is not None:
            bits.append(f"{nsrc}源")
        extra = " ".join(x for x in bits if x)
        out.append({
            "rank": int(rank) if isinstance(rank, int) else i,
            "title": title,
            "url": url,
            "name": src,
            "extra": extra,
            "metric": str(score) if score is not None else "",
        })
    return out


def parse_aihot_daily(raw: Any) -> list[dict[str, Any]]:
    report = raw.get("report") if isinstance(raw, dict) else None
    if not isinstance(report, dict):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    n = 0
    for sec in report.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        label = str(sec.get("label") or "").strip()
        for it in sec.get("items") or []:
            if not isinstance(it, dict):
                continue
            title = str(it.get("title") or "").strip()
            url = _item_url(it)
            if not title:
                continue
            key = url or title
            if key in seen:
                continue
            seen.add(key)
            n += 1
            src = _src_name(it.get("source"))
            extra = " ".join(x for x in (label, src) if x)
            out.append({"rank": n, "title": title, "url": url, "name": src, "extra": extra, "metric": ""})
    return out


def parse_aihot_topics(html: str) -> list[dict[str, Any]]:
    """Topic map cards from aihot.virxact.com/topics. Official v1 has no /topics."""
    marks: list[tuple[int, str, Any]] = []
    for m in _AH_H2.finditer(html or ""):
        marks.append((m.start(), "g", _plain(m.group(1))))
    for m in _AH_TOPIC.finditer(html or ""):
        marks.append((m.start(), "c", m))
    marks.sort(key=lambda x: x[0])
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    group = ""
    n = 0
    for _pos, kind, val in marks:
        if kind == "g":
            group = str(val)
            continue
        href = str(val.group(1) or "")
        title = _plain(val.group(2))
        count = (val.group(3) or "").replace(",", "")
        if not title or href in seen:
            continue
        seen.add(href)
        n += 1
        extra = " ".join(x for x in (group, f"{count}条" if count else "") if x)
        out.append({
            "rank": n,
            "title": title,
            "url": f"https://aihot.virxact.com{href}",
            "name": group,
            "extra": extra,
            "metric": count,
        })
    return out


def parse_aihot_bundle(raw: dict[str, Any]) -> dict[str, Any]:
    blob = raw if isinstance(raw, dict) else {}
    topics_html = blob.get("topics") or ""
    tabs = [
        {"id": "all", "name": "全部", "items": parse_aihot_items(blob.get("all"))},
        {"id": "selected", "name": "精选", "items": parse_aihot_items(blob.get("selected"))},
        {"id": "hot", "name": "热点", "items": parse_aihot_items(blob.get("hot"))},
        {"id": "daily", "name": "日报", "items": parse_aihot_daily(blob.get("daily"))},
        {"id": "topics", "name": "主题", "items": parse_aihot_topics(topics_html if isinstance(topics_html, str) else "")},
    ]
    return {"src": SRC_AIHOT, "tabs": tabs}


def aihot_ok(data: Any) -> bool:
    if not isinstance(data, dict) or not isinstance(data.get("tabs"), list):
        return False
    return any(isinstance(t, dict) and t.get("items") for t in data["tabs"])


def _live_aihot() -> dict[str, Any]:
    jobs = (
        ("all", f"{AIHOT_ITEMS}?mode=all&window=24h&by=timeline&limit=40", "json"),
        ("selected", f"{AIHOT_ITEMS}?mode=selected&limit=40", "json"),
        ("hot", AIHOT_HOT, "json"),
        ("daily", AIHOT_DAILY, "json"),
        ("topics", SRC_AIHOT_TOPICS, "html"),
    )
    out: dict[str, Any] = {}

    def pull(key: str, url: str, kind: str) -> tuple[str, Any]:
        try:
            if kind == "html":
                return key, _get(url)
            return key, _get_json(url, referer=SRC_AIHOT)
        except Exception as e:
            log.warning("aihot %s failed: %s", key, e)
            return key, None

    with ThreadPoolExecutor(max_workers=5) as pool:
        futs = [pool.submit(pull, k, u, kind) for k, u, kind in jobs]
        for fut in futs:
            key, data = fut.result()
            out[key] = data
    return out


def aihot(fetch: Fetch | None = None) -> dict[str, Any]:
    return parse_aihot_bundle((fetch or _live_aihot)())


def board_ok(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    return (
        sopilot_ok(data.get("sopilot"))
        or newsnow_ok(data.get("newsnow"))
        or rebang_ok(data.get("rebang"))
        or aihot_ok(data.get("aihot"))
    )
