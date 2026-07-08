"""订阅接入：调本机已装、已登录的 AI CLI（Claude Code / Qwen / DeepSeek / Codex），
用用户自己的订阅额度作答、免 API key。移植自 SDesign-opensource 的 cli-runtime（Node），
改为 Python subprocess + 一次性（非流式）取纯文本。

⚠️ 仅当后端跑在用户本机时可用——云端读不到用户本机的 CLI 与登录态。
CLI 不做 function-calling（不像 API 那条能让 AI 自己调数据工具）；因此订阅接入只适合
「数据已在提示词里」的场景（每日复盘 / 今日要点 / 个股页问 AI，页面已把数据塞进 context）。
"""

from __future__ import annotations

import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

# 提示词投递方式（各 CLI 接口不同）：
#   system-file —— 系统提示词写临时文件用 flag 传，用户提示词走 stdin（Claude）
#   stdin       —— 系统+用户合并走 stdin（Qwen / Codex）
#   arg         —— 系统+用户合并作为最后一个位置参数（DeepSeek）
_CLI_DEFS: dict[str, dict] = {
    "claude": {
        "bins": ["claude", "openclaude"],
        "delivery": "system-file",
        # -p 非交互、纯文本输出、系统提示词走文件；禁掉所有工具（只让它把问题答成文字，不读文件/联网/执行）
        "build_args": lambda sys_file: [
            "-p", "--output-format", "text", "--system-prompt-file", sys_file,
            "--disallowedTools", "Read", "Write", "Edit", "Glob", "Grep", "Bash",
            "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite", "Task",
        ],
        "env": {},
    },
    "qwen": {"bins": ["qwen"], "delivery": "stdin", "build_args": lambda _: ["--yolo"], "env": {}},
    # 注：Gemini CLI 已停止对个人版 Gemini Code Assist 的支持（登录报 "This client is no
    # longer supported for Gemini Code Assist for individuals"），故已从订阅接入中移除。
    "deepseek": {"bins": ["deepseek", "codewhale"], "delivery": "arg",
                 "build_args": lambda _: ["exec", "--auto"], "env": {}},
    # Codex：codex exec 默认纯文本（进度走 stderr、最终答案走 stdout）；`-` 从 stdin 读提示词，
    # --skip-git-repo-check 跳过 git 检查（我们在临时目录跑）。复用本机 `codex login` 的订阅登录态。
    "codex": {"bins": ["codex"], "delivery": "stdin",
              "build_args": lambda _: ["exec", "--skip-git-repo-check", "-"], "env": {}},
}

_EXTRA_PATH_DIRS = [
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
    "/Applications/Codex.app/Contents/Resources",
    str(Path.home() / ".local/bin"), str(Path.home() / ".npm-global/bin"),
    str(Path.home() / ".bun/bin"), str(Path.home() / ".deno/bin"),
    str(Path.home() / ".yarn/bin"),
]

_CLI_TIMEOUT_S = 300  # 子进程兜底超时（秒）
_MAX_ARG_BYTES = 110_000  # 位置参数投递的提示词字节上限


class CliUnavailable(RuntimeError):
    """本机未检测到对应 CLI（未安装 / 不在 PATH）。"""


def _find_bin(name: str) -> str | None:
    hit = shutil.which(name)
    if hit:
        return hit
    for d in _EXTRA_PATH_DIRS:
        p = Path(d) / name
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return None


def detect_cli(kind: str) -> str | None:
    """返回某订阅 CLI 的可执行路径，未装则 None。"""
    d = _CLI_DEFS.get(kind)
    if not d:
        return None
    for b in d["bins"]:
        found = _find_bin(b)
        if found:
            return found
    return None


def supported_kinds() -> list[str]:
    return list(_CLI_DEFS.keys())


def run_cli(kind: str, system_prompt: str, user_prompt: str) -> str:
    """起 CLI 子进程，一次性作答，返回纯文本 stdout。失败抛异常。"""
    d = _CLI_DEFS.get(kind)
    bin_path = detect_cli(kind)
    if not d or not bin_path:
        raise CliUnavailable(
            f"未检测到「{kind}」对应的本机命令。请先安装并登录该 CLI，或改用「API 接入」。"
        )

    combined = f"{system_prompt}\n\n{user_prompt}"
    env = {**os.environ, **d.get("env", {})}
    tmpdir = tempfile.mkdtemp(prefix="vibe-cli-")
    try:
        stdin_payload: str | None
        if d["delivery"] == "system-file":
            sys_file = str(Path(tmpdir) / "system.txt")
            Path(sys_file).write_text(system_prompt, encoding="utf-8")
            args = d["build_args"](sys_file)
            stdin_payload = user_prompt
        elif d["delivery"] == "stdin":
            args = d["build_args"](None)
            stdin_payload = combined
        else:  # arg
            if len(combined.encode("utf-8")) > _MAX_ARG_BYTES:
                raise RuntimeError(f"提示词过长，超过 {kind} 的命令行参数上限，请改用 Claude / Qwen 或 API 接入。")
            args = [*d["build_args"](None), combined]
            stdin_payload = None

        try:
            proc = subprocess.run(
                [bin_path, *args],
                input=stdin_payload,
                capture_output=True,
                text=True,
                cwd=tmpdir,
                env=env,
                timeout=_CLI_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"{kind} 生成超时（>{_CLI_TIMEOUT_S}s）") from e

        out = (proc.stdout or "").strip()
        if proc.returncode != 0 and not out:
            err = (proc.stderr or "").strip()[:300]
            raise RuntimeError(f"{kind} 退出码 {proc.returncode}{'：' + err if err else ''}")
        return out
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def run_cli_stream(kind: str, system_prompt: str, user_prompt: str):
    """流式版：起 CLI 子进程，stdout 边出边 yield 纯文本块。失败抛异常。"""
    d = _CLI_DEFS.get(kind)
    bin_path = detect_cli(kind)
    if not d or not bin_path:
        raise CliUnavailable(
            f"未检测到「{kind}」对应的本机命令。请先安装并登录该 CLI，或改用「API 接入」。"
        )

    combined = f"{system_prompt}\n\n{user_prompt}"
    env = {**os.environ, **d.get("env", {})}
    tmpdir = tempfile.mkdtemp(prefix="vibe-cli-")
    proc = None
    try:
        if d["delivery"] == "system-file":
            sys_file = str(Path(tmpdir) / "system.txt")
            Path(sys_file).write_text(system_prompt, encoding="utf-8")
            args = d["build_args"](sys_file)
            stdin_payload = user_prompt
        elif d["delivery"] == "stdin":
            args = d["build_args"](None)
            stdin_payload = combined
        else:  # arg
            if len(combined.encode("utf-8")) > _MAX_ARG_BYTES:
                raise RuntimeError(f"提示词过长，超过 {kind} 的命令行参数上限，请改用 Claude / Qwen 或 API 接入。")
            args = [*d["build_args"](None), combined]
            stdin_payload = None

        proc = subprocess.Popen(
            [bin_path, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, cwd=tmpdir, env=env, text=True, bufsize=1,
        )
        if stdin_payload is not None:
            try:
                proc.stdin.write(stdin_payload)
            except BrokenPipeError:
                pass
        if proc.stdin:
            proc.stdin.close()

        # 读线程 + 队列：让 _CLI_TIMEOUT_S 约束整个流式过程。
        # 直接 `for line in proc.stdout` 是无限期阻塞读——CLI 挂起时永远走不到
        # proc.wait(timeout=...)，超时形同虚设，子进程会常驻堆积。
        q: queue.Queue = queue.Queue()

        def _pump(stdout=proc.stdout):
            try:
                for ln in stdout:
                    q.put(ln)
            except Exception:
                pass
            finally:
                q.put(None)  # EOF 哨兵

        threading.Thread(target=_pump, daemon=True).start()
        deadline = time.monotonic() + _CLI_TIMEOUT_S
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"{kind} 生成超时（>{_CLI_TIMEOUT_S}s）")
            try:
                line = q.get(timeout=min(remaining, 1.0))
            except queue.Empty:
                continue
            if line is None:
                break
            yield line
        try:
            rc = proc.wait(timeout=10)
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"{kind} 输出已结束但进程未退出") from e
        if rc != 0:
            raise RuntimeError(f"{kind} 退出码 {rc}")
    finally:
        if proc and proc.poll() is None:
            proc.kill()
        shutil.rmtree(tmpdir, ignore_errors=True)
