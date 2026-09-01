"""Pack 复盘上下文: one text snapshot for 问 AI and review mail.

Missing panels are listed; do not invent numbers.
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

REVIEW_CONTEXT_MAX_CHARS = 24_000
_BJ = timezone(timedelta(hours=8))
log = logging.getLogger("review_context")

REVIEW_PROMPT_TASK = (
    "请用中文做当天大盘复盘, 按下面顺序写, 有数据才写、没数据就跳过:\n"
    "1. 整体涨跌与主要指数(含外围)\n"
    "2. 涨跌分布 / 情绪 / 涨跌停\n"
    "3. 板块与资金(领涨领跌、主力净流入)\n"
    "4. 个股榜与龙虎(只陈述公开榜单, 不荐股)\n"
    "5. 实时热点/快讯全文里与盘面相关的客观信息\n"
    "只做客观陈述与多视角分析, 不预测涨跌、不推荐任何标的、不构成投资建议。"
    "数字必须来自上面的快照, 不要编造。"
)

EXPECTED = (
    "全球指数",
    "涨跌分布",
    "涨跌停",
    "板块热点",
    "板块资金",
    "主力净流入",
    "个股榜单",
    "宏观观察",
    "实时热点",
    "自选",
    "龙虎榜",
    "资金利率",
)


def fmt_signed_pct(v: Any, digits: int = 2) -> str:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return "—"
    if n != n:  # NaN
        return "—"
    return f"{n:+.{digits}f}%"


def fmt_yi(v: Any) -> str:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return "—"
    if n != n or n == 0:
        return "—"
    sign = "-" if n < 0 else ""
    abs_n = abs(n)
    if abs_n >= 1e8:
        return f"{sign}{abs_n / 1e8:.2f}亿"
    if abs_n >= 1e4:
        return f"{sign}{abs_n / 1e4:.0f}万"
    return f"{sign}{abs_n:.0f}"


def take(rows: Any, n: int) -> list:
    if not isinstance(rows, list):
        return []
    return rows[:n]


def _num(v: Any) -> float | None:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n != n:
        return None
    return n


def _join(parts: list[str | None]) -> str:
    return "\n".join(p for p in parts if p and p.strip())


def _section(title: str, body: str | None) -> str | None:
    t = (body or "").strip()
    return f"【{title}】\n{t}" if t else None


def _quote_line(name: str, price: Any = None, pct: Any = None, amount: Any = None) -> str:
    bits = [name]
    p = _num(price)
    if p is not None:
        bits.append(str(p))
    bits.append(fmt_signed_pct(pct))
    a = _num(amount)
    if a is not None and a != 0:
        bits.append(f"额{fmt_yi(a)}")
    return " ".join(bits)


def _fmt_rate(v: Any) -> str:
    n = _num(v)
    if n is None:
        return "—"
    pct = n * 100 if n <= 1 else n
    return f"{pct:.1f}%"


def missing_panels(text: str) -> list[str]:
    return [name for name in EXPECTED if f"【{name}】" not in text]


def build_user_prompt(snap: str) -> str:
    return (
        "以下是今天复盘驾驶舱的客观快照(与当前看板同源):\n"
        f"{snap}\n\n{REVIEW_PROMPT_TASK}"
    )


def _world(data: dict) -> str | None:
    world = data.get("world") or []
    if isinstance(world, list) and world:
        lines = []
        for i in world:
            if not isinstance(i, dict):
                continue
            lines.append(_quote_line(
                str(i.get("name") or i.get("label") or ""),
                i.get("price"),
                i.get("change_pct") if i.get("change_pct") is not None else i.get("pct"),
                i.get("amount"),
            ))
        if lines:
            return "；".join(lines)
    indices = data.get("indices") or []
    if not isinstance(indices, list) or not indices:
        return None
    return "；".join(
        _quote_line(str(i.get("name") or ""), i.get("price"), i.get("change_pct"))
        for i in indices if isinstance(i, dict)
    )


def _sentiment(data: dict) -> str | None:
    ov = data.get("overview") or {}
    s = ov.get("sentiment") if isinstance(ov, dict) else None
    b = data.get("breadth") if isinstance(data.get("breadth"), dict) else None
    bits: list[str] = []
    counts = b if isinstance(b, dict) and (b.get("up") or 0) + (b.get("down") or 0) + (b.get("flat") or 0) > 0 else s
    if isinstance(counts, dict) and (counts.get("up") or 0) + (counts.get("down") or 0) + (counts.get("flat") or 0) > 0:
        line = f"上涨{counts.get('up')} 平{counts.get('flat')} 下跌{counts.get('down')}"
        if isinstance(s, dict) and (s.get("zt") or s.get("dt")):
            line += f"；涨停{s.get('zt')}(真实{s.get('zt_real')}) 跌停{s.get('dt')}(真实{s.get('dt_real')})"
        bits.append(line)
        if isinstance(s, dict) and s.get("breadth"):
            bits.append(f"广度 {s.get('breadth')}")
        if isinstance(s, dict) and s.get("speculation"):
            bits.append(f"投机 {s.get('speculation')}")
        stamp = (b.get("updated") if isinstance(b, dict) else None) or None
        if stamp:
            bits.append(f"更新 {stamp}")
    if isinstance(b, dict) and b.get("n"):
        pcts = []
        for k, label in (("p10", "p10"), ("p25", "p25"), ("p50", "p50"),
                         ("p75", "p75"), ("p90", "p90"), ("avg", "均")):
            if b.get(k) is not None:
                pcts.append(f"{label} {fmt_signed_pct(b.get(k))}")
        bits.append(f"全A分位 n={b.get('n')}" + (f" {' '.join(pcts)}" if pcts else ""))
        hist = b.get("histogram") or []
        if isinstance(hist, list) and hist:
            bits.append("分布 " + " ".join(
                f"{h.get('label')}:{h.get('count')}" for h in hist if isinstance(h, dict)
            ))
    return "\n".join(bits) if bits else None


def _emotion(e: Any) -> str | None:
    if not isinstance(e, dict):
        return None
    bits = [
        f"涨停{e.get('zt_count')} 跌停{e.get('dt_count')} 炸板{e.get('zb_count')} 昨涨停{e.get('yzt_count')}",
        f"最高连板{e.get('max_boards')} 连板家数{e.get('lianban_count')}",
    ]
    if e.get("seal_rate") is not None:
        bits.append(f"封板率{_fmt_rate(e.get('seal_rate'))}")
    if e.get("break_rate") is not None:
        bits.append(f"炸板率{_fmt_rate(e.get('break_rate'))}")
    if e.get("promotion_rate") is not None:
        bits.append(f"晋级率{_fmt_rate(e.get('promotion_rate'))}")
    seals = e.get("seals")
    if isinstance(seals, dict):
        bits.append(
            f"封板 真{seals.get('sealed_up')}/假{seals.get('fake_up')} "
            f"跌停封 真{seals.get('sealed_down')}/假{seals.get('fake_down')}"
        )
    up = take(e.get("zt_stocks") or e.get("lianban_stocks"), 8)
    if up:
        bits.append("连板 " + "；".join(
            f"{s.get('name')}({s.get('boards')}板 {fmt_signed_pct(s.get('pct'))} {s.get('industry') or ''})".strip()
            for s in up if isinstance(s, dict)
        ))
    down = take(e.get("dt_stocks"), 6)
    if down:
        bits.append("跌停 " + "；".join(
            f"{s.get('name')}({s.get('boards')}跌 {s.get('industry') or ''})".strip()
            for s in down if isinstance(s, dict)
        ))
    return "\n".join(bits)


def _board_line(b: dict) -> str:
    lead = ""
    if b.get("lead_name"):
        extra = fmt_signed_pct(b.get("lead_pct"), 1) if b.get("lead_pct") is not None else ""
        lead = f" 领{b.get('lead_name')}{extra}"
    return f"{b.get('name')} {fmt_signed_pct(b.get('pct'))}{lead}"


def _sectors(data: dict) -> str | None:
    up = [x for x in take(data.get("sector_up"), 8) if isinstance(x, dict)]
    down = [x for x in take(data.get("sector_down"), 8) if isinstance(x, dict)]
    bits: list[str] = []
    if up:
        bits.append("领涨行业 " + "；".join(_board_line(b) for b in up))
    if down:
        bits.append("领跌行业 " + "；".join(_board_line(b) for b in down))
    if bits:
        return "\n".join(bits)
    industry = data.get("industry") if isinstance(data.get("industry"), dict) else None
    if not industry:
        return None
    top = take(industry.get("top"), 8)
    bot = take(industry.get("bottom"), 8)
    if top:
        bits.append("行业强 " + "；".join(
            f"{r.get('name')} {fmt_signed_pct(r.get('change_pct'))}"
            for r in top if isinstance(r, dict)
        ))
    if bot:
        bits.append("行业弱 " + "；".join(
            f"{r.get('name')} {fmt_signed_pct(r.get('change_pct'))}"
            for r in bot if isinstance(r, dict)
        ))
    return "\n".join(bits) if bits else None


def _flow(rows: Any) -> str | None:
    items = [r for r in (rows or []) if isinstance(r, dict) and _num(r.get("net_in")) is not None]
    if not items:
        return None
    items.sort(key=lambda r: float(r.get("net_in") or 0), reverse=True)
    inn = [r for r in items if float(r.get("net_in") or 0) > 0][:8]
    out = [r for r in reversed(items) if float(r.get("net_in") or 0) < 0][:8]
    bits: list[str] = []
    if inn:
        bits.append("流入 " + "；".join(f"{r.get('name')} {fmt_yi(r.get('net_in'))}" for r in inn))
    if out:
        bits.append("流出 " + "；".join(f"{r.get('name')} {fmt_yi(r.get('net_in'))}" for r in out))
    return "\n".join(bits) if bits else None


def _money(rows: Any) -> str | None:
    items = take(rows, 10)
    if not items:
        return None
    lines = []
    for r in items:
        if not isinstance(r, dict):
            continue
        extra = f"{fmt_signed_pct(r.get('change_pct'))} 主力{fmt_yi(r.get('main_net'))}"
        if r.get("main_pct") is not None:
            extra += f" {float(r.get('main_pct')):.1f}%"
        lines.append(f"{r.get('name')} {extra}".strip())
    return "；".join(lines) if lines else None


def _rank(data: dict) -> str | None:
    def line(rows: Any) -> str:
        return "；".join(
            f"{s.get('name')} {fmt_signed_pct(s.get('pct'))} 额{fmt_yi(s.get('amount'))}"
            for s in take(rows, 8) if isinstance(s, dict)
        )
    bits: list[str] = []
    if data.get("rank_hot"):
        bits.append(f"热门 {line(data.get('rank_hot'))}")
    if data.get("rank_up"):
        bits.append(f"涨幅 {line(data.get('rank_up'))}")
    if data.get("rank_down"):
        bits.append(f"跌幅 {line(data.get('rank_down'))}")
    return "\n".join(bits) if bits else None


def _commodities(quotes: Any) -> str | None:
    if not isinstance(quotes, dict) or not quotes:
        return None
    lines = []
    for code, q in quotes.items():
        if not isinstance(q, dict):
            continue
        name = q.get("name") or code
        lines.append(_quote_line(str(name), q.get("price"), q.get("pct") if q.get("pct") is not None else q.get("change_pct")))
    return "；".join(lines) if lines else None


def _fear_greed(raw: Any) -> str | None:
    items = raw.get("items") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return None
    lines = []
    for it in items:
        if not isinstance(it, dict) or it.get("score") is None:
            continue
        title = str(it.get("title") or it.get("key") or "").strip()
        if not title:
            continue
        label = str(it.get("label") or "").strip()
        extra = str(it.get("detail") or "").strip()
        bit = f"{title} {int(it['score'])} {label}".strip()
        if extra:
            bit = f"{bit} {extra}"
        lines.append(bit)
    return "全球情绪 " + "；".join(lines) if lines else None


def _macro(data: dict) -> str | None:
    return _join([_commodities(data.get("commodities")), _fear_greed(data.get("fear_greed"))]) or None


def _news(items: Any) -> str | None:
    rows = take(items, 12)
    if not rows:
        return None
    blocks = []
    for i, it in enumerate(rows, 1):
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()
        if not title:
            continue
        time = str(it.get("time") or "")
        clock = time[11:16] if len(time) >= 16 else time[-5:]
        extra = str(it.get("content") or it.get("summary") or "").replace("\n", " ").strip()
        cats = [str(c).strip() for c in (it.get("tags") or []) if str(c).strip()][:3]
        prefix = f"[{' '.join(cats)}] " if cats else ""
        head = f"{i}. {clock} {prefix}{title}".strip()
        blocks.append(f"{head}\n{extra}" if extra and extra != title else head)
    return "快讯\n" + "\n".join(blocks) if blocks else None


def _lhb(lhb: Any) -> str | None:
    if not isinstance(lhb, dict):
        return None
    rows = take(lhb.get("stocks"), 8)
    if not rows:
        return None
    head = ""
    if lhb.get("date"):
        head = f"{lhb.get('date')} 共{lhb.get('total_records')}条"
    body = "；".join(
        f"{s.get('name')} {fmt_signed_pct(s.get('change_pct'))} "
        f"净买{float(s.get('net_buy_wan') or 0):.0f}万 {s.get('reason') or ''}".strip()
        for s in rows if isinstance(s, dict)
    )
    return "\n".join(p for p in (head, body) if p)


def _watch(rows: Any) -> str | None:
    items = take(rows, 20)
    if not items:
        return None
    lines = []
    for r in items:
        if not isinstance(r, dict):
            continue
        name = str(r.get("name") or "")
        if not name:
            continue
        if r.get("price") is None and r.get("pct") is None:
            lines.append(name)
        else:
            lines.append(_quote_line(name, r.get("price"), r.get("pct") if r.get("pct") is not None else r.get("change_pct"), r.get("amount")))
    return "；".join(lines) if lines else None


def _rates(data: dict) -> str | None:
    bits: list[str] = []
    hsgt = data.get("hsgt") if isinstance(data.get("hsgt"), dict) else None
    latest = hsgt.get("latest") if hsgt else None
    if isinstance(latest, dict):
        bits.append(
            f"北向 {latest.get('time') or ''} "
            f"沪{latest.get('hgt_yi') if latest.get('hgt_yi') is not None else '—'}亿 "
            f"深{latest.get('sgt_yi') if latest.get('sgt_yi') is not None else '—'}亿".strip()
        )
    etf = data.get("etf_flow")
    if isinstance(etf, dict):
        etf = etf.get("rows")
    if isinstance(etf, list) and etf:
        rows = [r for r in etf if isinstance(r, dict)]
        inn = sorted(rows, key=lambda r: float(r.get("main_net_inflow") or 0), reverse=True)[:5]
        out = sorted(rows, key=lambda r: float(r.get("main_net_inflow") or 0))[:5]
        if inn:
            bits.append("ETF流入 " + "；".join(
                f"{r.get('name')} {fmt_yi(r.get('main_net_inflow'))} {fmt_signed_pct(r.get('change_pct'))}"
                for r in inn
            ))
        if out:
            bits.append("ETF流出 " + "；".join(
                f"{r.get('name')} {fmt_yi(r.get('main_net_inflow'))} {fmt_signed_pct(r.get('change_pct'))}"
                for r in out
            ))
    sh_raw = data.get("sh_chg")
    if isinstance(sh_raw, dict):
        sh_raw = sh_raw.get("rows")
    chg = take(sh_raw, 5)
    if chg:
        bits.append("增减持 " + "；".join(
            f"{r.get('name')} {r.get('change_type')} {r.get('person')}"
            for r in chg if isinstance(r, dict)
        ))
    lpr = data.get("lpr")
    lpr_row = None
    if isinstance(lpr, dict):
        lpr_row = lpr.get("latest") if isinstance(lpr.get("latest"), dict) else None
    elif isinstance(lpr, list) and lpr and isinstance(lpr[0], dict):
        lpr_row = lpr[0]
    if lpr_row:
        bits.append(
            f"LPR {lpr_row.get('date')} 1Y {lpr_row.get('one_year')}% 5Y {lpr_row.get('five_year')}%"
        )
    bond = data.get("bond_y") if isinstance(data.get("bond_y"), dict) else None
    if bond and isinstance(bond.get("terms"), dict) and bond["terms"]:
        t = bond["terms"]
        pick = [f"{k} {t[k]}%" for k in ("2Y", "10Y", "30Y") if t.get(k) is not None]
        spr = f" 10Y-2Y {bond['spread_10_2']:.2f}" if bond.get("spread_10_2") is not None else ""
        bits.append(f"国债 {bond.get('date')} {' '.join(pick)}{spr}".strip())
    return "\n".join(bits) if bits else None


def pack_review_context(data: dict[str, Any]) -> str:
    """Turn collected review dicts into the AI snapshot string."""
    body = _join([
        _section("全球指数", _world(data)),
        _section("涨跌分布", _sentiment(data)),
        _section("涨跌停", _emotion(data.get("emotion"))),
        _section("板块热点", _sectors(data)),
        _section("板块资金", _flow(data.get("board_flow"))),
        _section("主力净流入", _money(data.get("money_rows"))),
        _section("个股榜单", _rank(data)),
        _section("宏观观察", _macro(data)),
        _section("实时热点", _news(data.get("news"))),
        _section("自选", _watch(data.get("watch"))),
        _section("龙虎榜", _lhb(data.get("lhb"))),
        _section("资金利率", _rates(data)),
    ])
    miss = missing_panels(body)
    footer = f"\n【未取到】{'、'.join(miss)}。这些格子没有数据, 不要编造数字。" if miss else ""
    text = (body or "（复盘看板数据尚未加载）") + footer
    vs = format_vs_prior(text)
    if vs:
        text = f"{text}\n{vs}"
    if len(text) <= REVIEW_CONTEXT_MAX_CHARS:
        return text
    return text[:REVIEW_CONTEXT_MAX_CHARS] + "\n…(快照已截断)"


def _archive_enabled() -> bool:
    raw = (os.environ.get("VR_REVIEW_ARCHIVE") or "").strip().lower()
    if not raw:
        return True
    return raw not in ("0", "false", "no", "off")


def archive_dir() -> Path:
    root = Path(os.environ.get("VR_DATA_DIR") or (Path.home() / ".vibe-research"))
    d = root / "review-archive"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_archive(text: str, day: str | None = None) -> Path | None:
    """Write packed review-context for one calendar day. Overwrites same-day file."""
    if not _archive_enabled():
        return None
    body = (text or "").strip()
    if not body:
        return None
    day = day or datetime.now(_BJ).strftime("%Y-%m-%d")
    p = archive_dir() / f"{day}.txt"
    tmp = p.with_suffix(".txt.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(p)
    except OSError:
        log.warning("review archive write failed", exc_info=True)
        return None
    log.info("review archive %s (%s chars)", p.name, len(text))
    return p


def archive_from_bundle() -> Path | None:
    """Once per day: pack from current caches. Skip if today's file already exists."""
    if not _archive_enabled():
        return None
    day = datetime.now(_BJ).strftime("%Y-%m-%d")
    p = archive_dir() / f"{day}.txt"
    if p.is_file():
        return p
    import review_snapshot

    data, _ = review_snapshot.collect_review_bundle()
    return save_archive(pack_review_context(data), day)


_HEAD = re.compile(r"^【([^】]+)】[ \t]*", re.M)
_SKIP_SECTIONS = frozenset({"未取到", "相对昨日"})


def today_bj() -> str:
    return datetime.now(_BJ).strftime("%Y-%m-%d")


def archive_days() -> list[str]:
    if not _archive_enabled():
        return []
    out = [p.stem for p in archive_dir().glob("????-??-??.txt") if p.is_file()]
    return sorted(out)


def read_archive(day: str) -> str | None:
    if not _archive_enabled():
        return None
    p = archive_dir() / f"{day}.txt"
    if not p.is_file():
        return None
    try:
        return p.read_text(encoding="utf-8")
    except OSError:
        log.warning("review archive read failed %s", p.name, exc_info=True)
        return None


def prior_day(today: str | None = None) -> str | None:
    """Latest archived day strictly before today. None = still only one day."""
    day = today or today_bj()
    older = [d for d in archive_days() if d < day]
    return older[-1] if older else None


def split_sections(text: str) -> dict[str, str]:
    """【标题】 bodies. Skip 未取到 / 相对昨日 so a packed vs-prior line does not self-diff."""
    parts = _HEAD.split(text or "")
    out: dict[str, str] = {}
    it = iter(parts[1:])
    for name, raw in zip(it, it):
        if name in _SKIP_SECTIONS:
            continue
        body = "\n".join(ln.rstrip() for ln in (raw or "").strip().splitlines()).strip()
        if body:
            out[name] = body
    return out


def _clip(text: str, n: int = 160) -> str:
    s = re.sub(r"\s+", " ", (text or "").strip())
    return s if len(s) <= n else s[: n - 1] + "…"


def archive_diff(today_text: str, today: str | None = None) -> dict[str, Any]:
    """Compare today's packed snapshot to the last archived day.

    status is the truth: need_two_runs / unchanged / changed.
    Empty changes only when status=unchanged. need_two_runs keeps changes=None
    so a client cannot read [] as 'compared, nothing moved'.
    """
    day = today or today_bj()
    if not _archive_enabled():
        return {
            "status": "need_two_runs",
            "today": day,
            "prior": None,
            "message": "还只有一天, 没法比 (复盘存档已关)",
            "changes": None,
        }
    prior = prior_day(day)
    prior_text = read_archive(prior) if prior else None
    if not prior or prior_text is None:
        return {
            "status": "need_two_runs",
            "today": day,
            "prior": None,
            "message": "还只有一天, 没法比",
            "changes": None,
        }
    now = split_sections(today_text)
    old = split_sections(prior_text)
    names = list(dict.fromkeys([*old, *now]))
    changes: list[dict[str, str]] = []
    for name in names:
        a, b = old.get(name, ""), now.get(name, "")
        if a == b:
            continue
        if not a:
            kind = "added"
        elif not b:
            kind = "removed"
        else:
            kind = "changed"
        changes.append({
            "name": name,
            "kind": kind,
            "before": _clip(a),
            "after": _clip(b),
        })
    if not changes:
        return {
            "status": "unchanged",
            "today": day,
            "prior": prior,
            "message": f"比过了没变 (对照 {prior})",
            "changes": [],
        }
    return {
        "status": "changed",
        "today": day,
        "prior": prior,
        "message": f"对照 {prior}: {'、'.join(c['name'] for c in changes[:8])} 有变化",
        "changes": changes[:12],
    }


def format_vs_prior(today_text: str, today: str | None = None) -> str:
    """One packed line for 问 AI / 邮件. Not an EXPECTED panel."""
    d = archive_diff(today_text, today)
    extra = ""
    if d["status"] == "need_two_runs":
        extra = "不要把空变化说成没变。"
    elif d["status"] == "unchanged":
        extra = "这是比过之后的没变, 不是缺档。"
    body = f"{d['message']}。{extra}".strip()
    return f"【相对昨日】\n{body}"
