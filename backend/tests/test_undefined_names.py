"""Catch NameError leftovers after a module split (no network).

The 2026-08-16 gstock_deep split left symbols in the wrong file
(_et_today, datetime, _MKT_FS, gstock, _cik_cache, _STMT_REPORT, csv).
Those fail on the first request, before any upstream call.

This test walks Python symbol tables: a name used in a function but
never imported/assigned in that module is a fail. Stdlib only.
"""
from __future__ import annotations

import builtins
import importlib
import pathlib
import symtable

import pytest

_BACKEND = pathlib.Path(__file__).resolve().parents[1]
_SKIP_DIRS = {".venv", "__pycache__", "tests"}
_BUILTINS = set(dir(builtins)) | {
    "__name__",
    "__file__",
    "__package__",
    "__doc__",
    "__annotations__",
    "__spec__",
    "__loader__",
    "__cached__",
    "__builtins__",
    "__path__",
}


def _bound_names(table: symtable.SymbolTable) -> set[str]:
    return {
        s.get_name()
        for s in table.get_symbols()
        if s.is_assigned() or s.is_imported() or s.is_parameter() or s.is_namespace()
    }


def _module_bound(st: symtable.SymbolTable) -> set[str]:
    return {
        s.get_name()
        for s in st.get_symbols()
        if s.is_assigned() or s.is_imported() or s.is_namespace()
    }


def undefined_names(src: str, filename: str = "<src>") -> list[str]:
    """Return names that would raise NameError when the module runs."""
    st = symtable.symtable(src, filename, "exec")
    module_bound = _module_bound(st)
    hits: list[str] = []

    def walk(table: symtable.SymbolTable, enclosing: set[str]) -> None:
        local = _bound_names(table)
        visible = enclosing | local
        for s in table.get_symbols():
            if not s.is_referenced():
                continue
            name = s.get_name()
            if name in _BUILTINS or name.startswith("__"):
                continue
            if s.is_free():
                if name not in enclosing and name not in module_bound:
                    hits.append(name)
                continue
            if s.is_global() and table.get_type() != "module":
                if name not in module_bound:
                    hits.append(name)
                continue
            if name not in visible:
                hits.append(name)
        child_enclosing = enclosing if table.get_type() == "class" else visible
        for child in table.get_children():
            walk(child, child_enclosing)

    walk(st, set())
    return sorted(set(hits))


def _iter_backend_py() -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for path in sorted(_BACKEND.rglob("*.py")):
        if any(part in _SKIP_DIRS for part in path.parts):
            continue
        out.append(path)
    return out


@pytest.mark.parametrize(
    "src,expect",
    [
        ("def f():\n    return _et_today()\n", ["_et_today"]),
        ("def f(d):\n    return datetime.strptime(d, '%Y%m%d')\n", ["datetime"]),
        ("def f(q):\n    return gstock.resolve_symbol(q)\n", ["gstock"]),
        (
            "def f():\n    global _cik_cache\n    if _cik_cache is None:\n        _cik_cache = {}\n",
            ["_cik_cache"],
        ),
        ("def f(m):\n    return _MKT_FS.get(m)\n", ["_MKT_FS"]),
        (
            "def f(raw):\n    return list(csv.DictReader(io.StringIO(raw)))\n",
            ["csv", "io"],
        ),
        (
            "def f(s):\n    if s not in _STMT_REPORT:\n        return {}\n",
            ["_STMT_REPORT"],
        ),
    ],
)
def test_checker_catches_split_leftovers(src: str, expect: list[str]) -> None:
    assert undefined_names(src) == expect


@pytest.mark.parametrize(
    "src",
    [
        "from datetime import datetime\ndef f(d):\n    return datetime.strptime(d, '%Y%m%d')\n",
        "def outer(num):\n    return lambda: num + 1\n",
        "def f():\n    return [x for x in range(3) if x > 0]\n",
        (
            "def f():\n"
            "    try:\n"
            "        1 / 0\n"
            "    except ZeroDivisionError as e:\n"
            "        return str(e)\n"
        ),
        "_MKT_FS = {'a': 1}\ndef f(m):\n    return _MKT_FS.get(m)\n",
        "import gstock\ndef f(q):\n    return gstock.resolve_symbol(q)\n",
    ],
)
def test_checker_allows_bound_names(src: str) -> None:
    assert undefined_names(src) == []


def test_backend_modules_have_no_undefined_names() -> None:
    """Scan routers / gstock_deep / data layer. Star-imports are skipped."""
    problems: list[str] = []
    scanned = 0
    for path in _iter_backend_py():
        src = path.read_text(encoding="utf-8")
        if "import *" in src:
            continue
        scanned += 1
        rel = path.relative_to(_BACKEND).as_posix()
        try:
            hits = undefined_names(src, rel)
        except SyntaxError as exc:
            problems.append(f"{rel}: syntax {exc}")
            continue
        if hits:
            problems.append(f"{rel}: {', '.join(hits)}")
    assert scanned > 40, f"scanner saw too few files: {scanned}"
    assert not problems, "undefined names (NameError at call time):\n" + "\n".join(problems)


def test_gstock_deep_and_routers_import() -> None:
    """Import-time NameError / circular import would fail here."""
    mods = [
        "gstock_deep",
        "gstock_deep.common",
        "gstock_deep.official",
        "gstock_deep.yahoo",
        "gstock_deep.eastmoney",
        "gstock_deep.sec",
        "gstock_deep.earnings",
        "gstock_deep.options",
        "gstock_deep.edgar",
        "gstock_deep.movers",
        "gstock",
        "routers.global_routes",
        "routers.market_routes",
        "astock_research",
        "routers.ashare",
        "routers.fin_routes",
        "routers.research_routes",
        "routers.ai_watch_routes",
        "ovlab_mqtt",
        "routers.ovlab_routes",
        "routers.fino_routes",
        "routers.portfolio",
        "routers.ai",
        "routers.core",
    ]
    for name in mods:
        importlib.import_module(name)


def _walk_api_routes(routes) -> list:
    out = []
    for r in routes:
        path = getattr(r, "path", None)
        if path and path.startswith("/api/") and callable(getattr(r, "endpoint", None)):
            out.append(r)
        nested = getattr(r, "routes", None)
        if nested:
            out.extend(_walk_api_routes(nested))
        included = getattr(r, "original_router", None)
        if included is not None and getattr(included, "routes", None):
            out.extend(_walk_api_routes(included.routes))
    return out


def test_fastapi_routes_are_bound() -> None:
    """App import succeeds and every HTTP route has a callable endpoint."""
    from app import app

    routes = _walk_api_routes(app.routes)
    assert len(routes) > 40
    paths = [r.path for r in routes]
    assert "/api/health" in paths
    assert "/api/global/earnings-calendar" in paths
