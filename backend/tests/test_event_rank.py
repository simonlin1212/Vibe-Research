"""event_rank: one parser per source, one cache family, not review warmup."""
from __future__ import annotations

import inspect

import event_rank
import review_jobs
from routers import event_routes

SOPILOT = """
<h2>飙升起爆榜</h2>
<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-sm font-black bg-indigo-600 text-white">1</span>
<a href="https://x.com/sunyuchentron">孙宇晨<span class="font-normal text-slate-400">@<!-- -->sunyuchentron</span></a>
<span class="mt-0.5 block text-[11px] text-slate-400">6 小时前</span>
<span class="shrink-0 text-sm font-black text-indigo-600">2.5万 曝光/小时</span>
<a href="https://x.com/sunyuchentron/status/2094959751604163017">鉴于全网对我身高的争议已持续多日</a>
<svg class="lucide lucide-eye"></svg>2.5万
<svg class="lucide lucide-heart"></svg>153
<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-sm font-black">2</span>
<a href="https://x.com/_FORAB">AB<span class="font-normal text-slate-400">@<!-- -->_FORAB</span></a>
<span>2 小时前</span>
<span>2.1万 曝光/小时</span>
<a href="https://x.com/_FORAB/status/111">丁林葳被判 12 个月</a>
<svg class="lucide lucide-eye"></svg>3.2万
<h2>最热曝光榜</h2>
<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-sm font-black">1</span>
<a href="https://x.com/_FORAB">AB<span class="font-normal text-slate-400">@<!-- -->_FORAB</span></a>
<span>2 小时前</span>
<span>3.2万 曝光</span>
<a href="https://x.com/_FORAB/status/111">丁林葳被判 12 个月</a>
<svg class="lucide lucide-eye"></svg>3.2万
"""

REBANG = """
<div class="col-12 col-md-6 col-xl-4" data-filter="综合" role="listitem">
<h3 class="platform-title">微博</h3>
<p class="platform-time">一小时前更新 - 热搜</p>
<div class="list-container">
<a class="list-item-link" href="https://s.weibo.com/weibo?q=%23foo%23">
<span class="list-number">1</span>
<span class="list-text">失联人员深埋巨石和淤泥之下</span>
</a>
<a class="list-item-link" href="https://s.weibo.com/weibo?q=bar">
<span class="list-number">2</span>
<span class="list-text">花儿与少年2026官宣</span>
</a>
</div></div>
<div class="col-12" data-filter="综合">
<h3 class="platform-title">雪球</h3>
<p class="platform-time">一小时前更新</p>
<a class="list-item-link" href="https://xueqiu.com/a">
<span class="list-number">1</span>
<span class="list-text">不该出现</span>
</a>
</div>
<div class="col-12" data-filter="财经">
<h3 class="platform-title">东方财富</h3>
<p class="platform-time">一小时前更新</p>
<a class="list-item-link" href="https://finance.eastmoney.com/a/1.html">
<span class="list-number">1</span>
<span class="list-text">创业板指缩量调整</span>
</a>
</div>
"""

NN = {
    "cls-hot": {"items": [{"title": "长债危机会烧向股市吗", "url": "https://cls.cn/a"}]},
    "weibo": {"items": [{"title": "教体局介入家长群", "url": "https://s.weibo.com/a"}]},
    "wallstreetcn": {"items": []},
    "jin10": {"items": [{"title": "乌外长谈俄资产", "url": "https://jin10.com/a"}]},
    "gelonghui": {"items": []},
    "zhihu": {"items": []},
}

AH = {
    "all": {
        "items": [
            {
                "title": "VAST 宣布完成 B 轮",
                "links": {"original": "https://elsewhere.news/a", "aihot": "https://aihot.virxact.com/items/1"},
                "source": {"name": "elsewhere"},
                "score": 36,
            }
        ]
    },
    "selected": {"items": []},
    "hot": {
        "items": [
            {
                "rank": 1,
                "title": "Claude Fable 5.1",
                "source": {"name": "Anthropic"},
                "sourceCount": 14,
                "links": {"original": "https://www.anthropic.com/a"},
            }
        ]
    },
    "daily": {
        "report": {
            "sections": [
                {
                    "label": "模型",
                    "items": [
                        {
                            "title": "Qwen3.8-Max-0902",
                            "source": {"name": "阿里云"},
                            "links": {"original": "https://qwen.ai/a"},
                        }
                    ],
                }
            ]
        }
    },
}


def test_parse_sopilot_splits_rising_and_hot():
    out = event_rank.parse_sopilot(SOPILOT)
    assert event_rank.sopilot_ok(out)
    assert out["src"] == event_rank.SRC_SOPILOT
    assert out["rising"][0]["handle"] == "sunyuchentron"
    assert "身高" in out["rising"][0]["title"]
    assert out["rising"][0]["metric"].endswith("/时")
    assert out["rising"][1]["handle"] == "_FORAB"
    assert out["hot"][0]["title"] == "丁林葳被判 12 个月"
    assert out["hot"][0]["url"].endswith("/111")


def test_parse_newsnow_skips_empty_and_keeps_order():
    out = event_rank.parse_newsnow_bundle(NN)
    assert event_rank.newsnow_ok(out)
    names = [t["name"] for t in out["tabs"]]
    assert names[0] == "财联社"
    cls = out["tabs"][0]
    assert cls["items"][0]["title"] == "长债危机会烧向股市吗"
    weibo = next(t for t in out["tabs"] if t["id"] == "weibo")
    assert weibo["items"][0]["rank"] == 1


def test_parse_rebang_cards_and_merge():
    tabs = event_rank.parse_rebang_pages([REBANG, REBANG])
    assert [t["name"] for t in tabs] == ["微博", "东方财富"]
    assert not any(t["name"] == "雪球" for t in tabs)
    assert tabs[0]["cat"] == "综合"
    assert "热搜" in tabs[0]["hint"]
    assert tabs[0]["items"][0]["title"] == "失联人员深埋巨石和淤泥之下"
    assert "foo" in tabs[0]["items"][0]["url"]
    board = event_rank.parse_rebang_board([REBANG])
    assert event_rank.rebang_ok(board)


AH_TOPICS = """
<h2>公司与模型</h2>
<a class="topics-grid-card" href="/topics/openai">
<span class="topics-grid-name">OpenAI / ChatGPT</span>
<span class="topics-grid-def">OpenAI 的全部动态</span>
<span class="topics-grid-count">查看 <!-- -->448<!-- --> 条精选 →</span>
</a>
<h2>技术方向</h2>
<a class="topics-grid-card" href="/topics/agent">
<span class="topics-grid-name">Agent 智能体</span>
<span class="topics-grid-count">查看 <!-- -->1,067<!-- --> 条精选 →</span>
</a>
"""


def test_parse_aihot_tabs():
    out = event_rank.parse_aihot_bundle(AH)
    assert event_rank.aihot_ok(out)
    assert out["src"] == event_rank.SRC_AIHOT
    ids = [t["id"] for t in out["tabs"]]
    assert ids == ["all", "selected", "hot", "daily", "topics"]
    all_tab = out["tabs"][0]
    assert all_tab["items"][0]["title"] == "VAST 宣布完成 B 轮"
    assert all_tab["items"][0]["url"].endswith("/a")
    assert "36" in all_tab["items"][0]["extra"]
    hot = out["tabs"][2]
    assert hot["items"][0]["rank"] == 1
    assert "14源" in hot["items"][0]["extra"]
    daily = out["tabs"][3]
    assert daily["items"][0]["title"] == "Qwen3.8-Max-0902"
    assert "模型" in daily["items"][0]["extra"]
    assert out["tabs"][4]["items"] == []


def test_parse_aihot_topics():
    items = event_rank.parse_aihot_topics(AH_TOPICS)
    assert items[0]["title"] == "OpenAI / ChatGPT"
    assert items[0]["url"].endswith("/topics/openai")
    assert "448条" in items[0]["extra"]
    assert items[0]["name"] == "公司与模型"
    assert items[1]["title"] == "Agent 智能体"
    assert items[1]["metric"] == "1067"
    assert "技术方向" in items[1]["extra"]
    bundled = event_rank.parse_aihot_bundle({**AH, "topics": AH_TOPICS})
    assert bundled["tabs"][4]["items"][0]["title"] == "OpenAI / ChatGPT"


def test_inject_fetch_and_board_ok():
    out = {
        "sopilot": event_rank.sopilot(fetch=lambda: SOPILOT),
        "newsnow": event_rank.newsnow(fetch=lambda: NN),
        "rebang": event_rank.rebang(fetch=lambda: [REBANG]),
        "aihot": event_rank.aihot(fetch=lambda: AH),
    }
    assert event_rank.board_ok(out)
    assert event_rank.board_ok({"sopilot": None, "newsnow": None, "rebang": None, "aihot": out["aihot"]})
    assert not event_rank.board_ok({"sopilot": None, "newsnow": None, "rebang": None, "aihot": None})


def test_http_keys_not_in_review_jobs():
    src = inspect.getsource(event_routes)
    assert '"event_rank"' in src and "_cached" in src and "_serve" in src
    assert "180" in src
    assert "event_rank.sopilot" in src
    assert "event_rank.newsnow" in src
    assert "event_rank.rebang" in src
    assert "event_rank.aihot" in src
    assert "part" in src and "unknown part" in src
    assert "telegraph" not in src.lower() or "Not telegraph" in src
    warm = inspect.getsource(review_jobs.warm_dc_jobs)
    live = inspect.getsource(review_jobs.live_jobs)
    assert "event_rank" not in warm
    assert "event_rank" not in live
    assert "sopilot" not in warm
    assert "newsnow" not in warm
    assert "open2hub" not in warm
