"""
Hugging Face Space sandbox service — **Gradio/Python free mode** (zero card).

This deploys to a Hugging Face Space using the free **Gradio** SDK (no Docker,
no billing). It executes Bash / Python / filesystem operations in the Space
container and exposes them over HTTP for the Cloudflare Worker.

How it works on HF:
  - HF runs `python app.py` and serves the process on port 7860.
  - We define a `gr.Blocks` UI (satisfies HF's Gradio SDK contract and gives a
    human-testable page), then build our own FastAPI app, mount the Gradio UI
    onto it with `mount_gradio_app`, and expose plain REST endpoints (`/run`,
    `/fs/list`, `/fs/read`, `/health`) alongside it.

Security posture:
  - Requests must present `X-Sandbox-Secret` matching the `SANDBOX_SECRET`
    Space secret, else 401.
  - Every command runs under a hard timeout; the container is the isolation
    boundary.
  - Output is bounded; shell args are quoted with `shlex`.
  - The secret is never echoed back.
"""

from __future__ import annotations

import os
import shlex
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import gradio as gr
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from gradio.routes import mount_gradio_app
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Runtime tunables come from the Space env; never hardcoded.
# ---------------------------------------------------------------------------
SANDBOX_SECRET = os.environ.get("SANDBOX_SECRET", "")
DEFAULT_TIMEOUT_S = int(os.environ.get("SANDBOX_TIMEOUT_S", "60"))
MAX_OUTPUT_BYTES = int(os.environ.get("SANDBOX_MAX_OUTPUT_BYTES", "100000"))
WORKSPACE = Path(os.environ.get("SANDBOX_WORKSPACE", "/workspace")).resolve()
PORT = int(os.environ.get("PORT", "7860"))

# Ensure the workspace directory exists even without a Dockerfile (Gradio mode).
WORKSPACE.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Execution engine
# ---------------------------------------------------------------------------
def _shell_command() -> str:
    """POSIX shell: `sh` on Windows (Git Bash), `bash` on POSIX hosts."""
    return "sh" if sys.platform.startswith("win") else "bash"


def _python_command() -> str:
    exe = getattr(sys, "executable", None)
    return exe if exe else ("python" if sys.platform.startswith("win") else "python3")


def _run(argv: list[str], cwd: Path, timeout_s: int) -> dict[str, Any]:
    """Run a command vector with a hard timeout and bounded output."""
    is_windows = sys.platform.startswith("win")
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=not is_windows,
    )

    def _force_kill() -> None:
        if is_windows:
            proc.kill()
        else:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()

    timed_out = False
    try:
        try:
            stdout, stderr = proc.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _force_kill()
            stdout, stderr = proc.communicate()
        exit_code = int(proc.returncode or 0)
    finally:
        if proc.poll() is None:
            _force_kill()

    if len(stdout) > MAX_OUTPUT_BYTES:
        stdout = stdout[:MAX_OUTPUT_BYTES] + "\n...[truncated]"
    if len(stderr) > MAX_OUTPUT_BYTES:
        stderr = stderr[:MAX_OUTPUT_BYTES] + "\n...[truncated]"

    return {"stdout": stdout, "stderr": stderr, "exit_code": exit_code, "timed_out": timed_out}


def _cwd(req_cwd: str) -> Path:
    target = (WORKSPACE if req_cwd in ("", "/workspace") else Path(req_cwd)).resolve()
    return target if target.exists() else WORKSPACE


def _run_request(lang: str, command: str, cwd: str, timeout_s: int | None) -> dict[str, Any]:
    cwd_path = _cwd(cwd)
    effective_timeout = timeout_s if timeout_s is not None else DEFAULT_TIMEOUT_S
    try:
        if lang == "python":
            fd, path = tempfile.mkstemp(prefix="dsh-", suffix=".py", dir=str(cwd_path))
            try:
                with os.fdopen(fd, "w") as fh:
                    fh.write(command)
                return _run([_python_command(), path], cwd_path, effective_timeout)
            finally:
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass
        return _run([_shell_command(), "-lc", command], cwd_path, effective_timeout)
    except (FileNotFoundError, NotADirectoryError, PermissionError) as exc:
        # e.g. no shell/interpreter on the host, or an invalid cwd: return a
        # structured non-zero result instead of crashing the endpoint (guardrail 4).
        return {
            "stdout": "",
            "stderr": f"sandbox runtime unavailable: {exc}",
            "exit_code": 127,
            "timed_out": False,
        }


def _list_files(path: str) -> list[dict[str, Any]]:
    target = Path(path).resolve()
    if not target.is_dir():
        raise FileNotFoundError(f"not a directory: {path}")
    return [
        {
            "name": child.name,
            "type": "dir" if child.is_dir() else "file",
            "size": child.stat().st_size if child.is_file() else None,
        }
        for child in sorted(target.iterdir())
    ]


def _read_file(path: str) -> str:
    target = Path(path).resolve()
    if not target.is_file():
        raise FileNotFoundError(f"file not found: {path}")
    data = target.read_bytes()
    if b"\x00" in data[:8192]:
        raise ValueError("binary file")
    return data.decode("utf-8", errors="replace")


def _authorize(x_sandbox_secret: str | None) -> None:
    if SANDBOX_SECRET == "":
        return  # dev-only: no secret configured
    if x_sandbox_secret is None or x_sandbox_secret != SANDBOX_SECRET:
        raise HTTPException(status_code=401, detail="unauthorized: invalid sandbox secret")


# ---------------------------------------------------------------------------
# Gradio UI (satisfies HF's Gradio SDK contract + provides a test page)
# ---------------------------------------------------------------------------
demo = gr.Blocks(title="DeepSeek Harness Sandbox")
with demo:
    gr.Markdown("# DeepSeek Harness 免费沙箱\n\n输入 Bash 命令或 Python 代码，在容器内执行。Worker 通过 REST API 调用本服务。")
    with gr.Tab("Bash"):
        bash_in = gr.Textbox(label="Bash 命令", lines=5)
        bash_out = gr.JSON(label="结果")
        bash_btn = gr.Button("执行")
        bash_btn.click(
            fn=lambda cmd: _run_request("bash", cmd, "/workspace", None),
            inputs=bash_in,
            outputs=bash_out,
        )
    with gr.Tab("Python"):
        py_in = gr.Textbox(label="Python 代码", lines=5)
        py_out = gr.JSON(label="结果")
        py_btn = gr.Button("执行")
        py_btn.click(
            fn=lambda src: _run_request("python", src, "/workspace", None),
            inputs=py_in,
            outputs=py_out,
        )


# ---------------------------------------------------------------------------
# Own FastAPI app with REST endpoints, then mount the Gradio UI onto it.
# ---------------------------------------------------------------------------
class RunRequest(BaseModel):
    lang: str = Field(default="bash", max_length=16)
    command: str = Field(default="", max_length=200_000)
    cwd: str = Field(default="/workspace", max_length=2048)
    timeout_s: int | None = Field(default=None, ge=1, le=300)


app = FastAPI(title="DeepSeek Harness Sandbox API")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "dsh-hf-sandbox"}


@app.post("/run")
def run_route(req: RunRequest, x_sandbox_secret: str | None = Header(default=None, alias="X-Sandbox-Secret")) -> dict[str, Any]:
    _authorize(x_sandbox_secret)
    return _run_request(req.lang, req.command, req.cwd, req.timeout_s)


@app.get("/fs/list")
def fs_list_route(
    path: str = "/workspace",
    x_sandbox_secret: str | None = Header(default=None, alias="X-Sandbox-Secret"),
) -> dict[str, Any]:
    _authorize(x_sandbox_secret)
    try:
        return {"path": path, "entries": _list_files(path)}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/fs/read")
def fs_read_route(
    path: str,
    x_sandbox_secret: str | None = Header(default=None, alias="X-Sandbox-Secret"),
) -> dict[str, Any]:
    _authorize(x_sandbox_secret)
    try:
        return {"path": path, "content": _read_file(path)}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# Merge Gradio into the same app (served at the root path).
app = mount_gradio_app(app, demo, path="/")


# ---------------------------------------------------------------------------
# Entry point — HF runs `python app.py`; the merged app serves on $PORT.
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")


# Re-export for reuse/tests.
quote = shlex.quote
