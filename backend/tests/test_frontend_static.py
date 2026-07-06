"""前端关键交互的静态回归测试。"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
INTEL_PAGE = ROOT / "frontend" / "src" / "pages" / "Intel.tsx"
INTEL_STORE = ROOT / "frontend" / "src" / "lib" / "intelDigestStore.ts"


def _read_text(path: Path) -> str:
    """读取文本文件内容。

    Args:
        path: 待读取的文件路径。

    Returns:
        文件的完整文本内容。
    """
    return path.read_text(encoding="utf-8")


def test_intel_digest_state_lives_outside_component():
    """验证资讯提炼状态不再保存在页面组件内。"""
    page = _read_text(INTEL_PAGE)

    assert "useIntelDigestStore()" in page
    assert "generateAllIndustryDigests(industries, cur)" in page
    assert "useState<Record<string, Digest>>" not in page
    assert "const [bulk, setBulk]" not in page


def test_intel_digest_store_keeps_single_bulk_job():
    """验证批量提炼任务使用页面外单例保存进度。"""
    store = _read_text(INTEL_STORE)

    assert "useSyncExternalStore" in store
    assert "let bulkJob: Promise<void> | null = null;" in store
    assert "if (bulkJob) return bulkJob;" in store
    assert "setBulk({ running: true, done: 0, total: targets.length })" in store
