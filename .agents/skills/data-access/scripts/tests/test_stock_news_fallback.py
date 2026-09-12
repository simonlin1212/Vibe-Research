"""PR #43: exercise requests, failure states and mapper provenance without network."""
import json
import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sources import eastmoney, mappers
from sources._http import capture, record_raw


ARTICLE = {"title": "<em>公司</em>公告", "content": "公告摘要", "date": "2026-09-11 12:00:00",
           "mediaName": "公开媒体", "code": "202609111234567890"}


def install_responses(monkeypatch, responses):
    calls = []

    def get(url, **kw):
        calls.append(kw)
        item = responses[len(calls) - 1]
        if isinstance(item, Exception):
            raise item
        response = requests.Response()
        response.status_code = 200
        response.encoding = "utf-8"
        body = item if isinstance(item, str) else kw["params"]["cb"] + "(" + json.dumps(item) + ");"
        response._content = body.encode()
        response._vra_raw_ref = record_raw(response.content, "js", url)
        return response

    monkeypatch.setattr(eastmoney, "em", get)
    return calls


def payload(rows):
    return {"result": {"cmsArticleWebOld": rows}}


def test_primary_success_does_not_retry_and_constructs_article_url(monkeypatch, tmp_path):
    calls = install_responses(monkeypatch, [payload([ARTICLE])])
    with capture(str(tmp_path), "eastmoney", "news") as cap:
        rows = eastmoney.eastmoney_stock_news("600519")
    assert len(calls) == 1
    assert rows[0]["title"] == "公司公告"
    assert rows[0]["url"] == "https://finance.eastmoney.com/a/202609111234567890.html"
    assert rows[0]["_raw"] == cap.raws[0]["raw_ref"]


@pytest.mark.parametrize("primary", [payload([]), requests.Timeout("private-detail"), "<html>blocked</html>", {},
                                     payload(None), payload([{"title": None}])])
def test_fallback_maps_its_own_raw_and_discloses_degradation(monkeypatch, tmp_path, primary):
    calls = install_responses(monkeypatch, [primary, payload([ARTICLE])])
    with capture(str(tmp_path), "eastmoney", "news") as cap:
        rows = eastmoney.eastmoney_stock_news("600519", 7)
        ctx = {"script": "em_stock_news", "symbol": "600519", "market": "SH", "source": "eastmoney",
               "endpoint": "news", "raw_ref": "raw/wrong-primary.js", "args": {}, "ep": {}}
        mapped = mappers.em_stock_news(rows, ctx)
    assert len(calls) == 2
    assert calls[1]["params"]["cb"] != calls[0]["params"]["cb"]
    assert "_" in calls[1]["params"]
    for call in calls:
        assert call["timeout"] == 15
        assert not any(k.lower() in ("cookie", "authorization") for k in call["headers"])
        assert json.loads(call["params"]["param"])["param"]["cmsArticleWebOld"]["pageSize"] == 7
    assert mapped["status"] == "partial"
    assert "同一东财" in mapped["degraded"]
    assert "private-detail" not in json.dumps(mapped)
    assert mapped["evidence"][0]["raw_ref"] == cap.raws[-1]["raw_ref"]


@pytest.mark.parametrize("responses", [
    [requests.Timeout("private-detail"), payload([])],
    [payload([]), requests.ConnectionError("private-detail")],
    [requests.Timeout("private-detail"), "<html>blocked</html>"],
    [{}, payload([])],
])
def test_failure_cannot_be_reported_as_empty(monkeypatch, responses):
    install_responses(monkeypatch, responses)
    with pytest.raises(RuntimeError, match="不能判定为没有新闻") as exc:
        eastmoney.eastmoney_stock_news("600519")
    assert "private-detail" not in str(exc.value)


def test_two_explicit_empty_responses_remain_distinct_from_failure(monkeypatch):
    install_responses(monkeypatch, [payload([]), payload([])])
    assert eastmoney.eastmoney_stock_news("600519") == []
    assert "两次请求均返回空列表" in mappers.em_stock_news([], {})["reason"]


@pytest.mark.parametrize("size", [0, -1, 101, True, 1.5])
def test_invalid_size_fails_before_network(monkeypatch, size):
    calls = install_responses(monkeypatch, [])
    with pytest.raises(ValueError):
        eastmoney.eastmoney_stock_news("600519", size)
    assert not calls


@pytest.mark.parametrize("responses,expected_exit,expected_status", [
    ([payload([ARTICLE])], 0, "ok"),
    ([payload([]), payload([ARTICLE])], 2, "partial"),
    ([requests.Timeout("private-detail"), payload([])], 3, "failed"),
])
def test_real_fetch_entry_status_and_persisted_evidence(monkeypatch, tmp_path, capsys,
                                                       responses, expected_exit, expected_status):
    import fetch_endpoint

    install_responses(monkeypatch, responses)
    monkeypatch.setattr(sys, "argv", ["fetch_endpoint.py", "--endpoint", "em_stock_news", "--symbol", "600519",
                                     "--out-dir", str(tmp_path)])
    with pytest.raises(SystemExit) as exc:
        fetch_endpoint.main()
    assert exc.value.code == expected_exit
    envelope = json.loads((tmp_path / "fetch" / "em_stock_news.json").read_text())
    assert envelope["status"] == expected_status
    assert "private-detail" not in json.dumps(envelope)
    for evidence in envelope["evidence"]:
        raw = tmp_path / evidence["raw_ref"]
        assert raw.is_file()
        assert ARTICLE["code"] in raw.read_text()
