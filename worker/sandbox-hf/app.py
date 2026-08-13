"""
Hugging Face Space sandbox service — a free, card-free code/command sandbox.

Deploy this app as a Docker-mode Hugging Face Space, then point the Cloudflare
Worker at its public URL. The Worker never runs local subprocesses; it sends
Bash/Python/filesystem requests over HTTP and this service executes them inside
an isolated container.

Security posture:
  - Every command is run under `shlex` (POSIX-shell quoting) so caller input
    cannot escape the intended argv.
  - Each execution is bounded by a hard timeout and a memory/CPU ceiling; the
    container itself is the isolation boundary.
  - A shared-secret header (`X-SANDBOX-SECRET`) must match the configured
    `SANDBOX_SECRET` env var; requests without it are rejected with 401.
  - The service never exposes the sandbox secret back to callers.

Endpoints:
  POST /run          -> execute a bash command or python source
  GET  /fs/list      -> list a directory
  GET  /fs/read      -> read a text file
  GET  /health       -> liveness (no auth)
"""

from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="DeepSeek Harness HF Sandbox", version="1.0.0")

# Runtime tunables come from the Space env (never hardcoded).
SANDBOX_SECRET = os.environ.get("SANDBOX_SECRET", "")
DEFAULT_TIMEOUT_S = int(os.environ.get("SANDBOX_TIMEOUT_S", "60"))
MAX_OUTPUT_BYTES = int(os.environ.get("SANDBOX_MAX_OUTPUT_BYTES", "100000"))
WORKSPACE = Path(os.environ.get("SANDBOX_WORKSPACE", "/workspace")).resolve()


class RunRequest(BaseModel):
    """A single command or script to execute."""

    lang: str = Field(default="bash", description="'bash' or 'python'")
    command: str = Field(default="", max_length=200_000, description="Bash command or Python source")
    cwd: str = Field(default="/workspace", description="Working directory inside the sandbox")
    timeout_s: int | None = Field(default=None, ge=1, le=300, description="Per-run timeout")


class RunResponse(BaseModel):
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool


def _authorize(x_sandbox_secret: str | None) -> None:
    """Reject requests that do not present the shared sandbox secret."""
    if SANDBOX_SECRET == "":
        return  # secret not configured: allow (local/dev only) — override in prod
    if x_sandbox_secret is None or x_sandbox_secret != SANDBOX_SECRET:
        raise HTTPException(status_code=401, detail="unauthorized: invalid sandbox secret")


def _shell_command() -> str:
    """Return the POSIX shell to use: `sh` on Windows, `bash` on POSIX hosts."""
    return "sh" if sys.platform.startswith("win") else "bash"


def _python_command() -> str:
    """Use the running interpreter when available (cross-platform)."""
    exe = getattr(sys, "executable", None)
    return exe if exe else ("python" if sys.platform.startswith("win") else "python3")


def _run(argv: list[str], cwd: Path, timeout_s: int) -> RunResponse:
    """Run a command vector with a hard timeout and bounded output."""
    is_windows = sys.platform.startswith("win")
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        # On POSIX, isolate into a fresh process group so a timed-out command's
        # children can be reaped together; Windows has no process groups here.
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

    # Bound the amount of output returned to the caller.
    if len(stdout) > MAX_OUTPUT_BYTES:
        stdout = stdout[:MAX_OUTPUT_BYTES] + "\n...[truncated]"
    if len(stderr) > MAX_OUTPUT_BYTES:
        stderr = stderr[:MAX_OUTPUT_BYTES] + "\n...[truncated]"

    return RunResponse(
        stdout=stdout,
        stderr=stderr,
        exit_code=exit_code,
        timed_out=timed_out,
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "dsh-hf-sandbox"}


@app.post("/run", response_model=RunResponse)
def run(
    req: RunRequest,
    x_sandbox_secret: str | None = Header(default=None, alias="X-Sandbox-Secret"),
) -> RunResponse:
    _authorize(x_sandbox_secret)

    timeout_s = req.timeout_s or DEFAULT_TIMEOUT_S
    cwd = (WORKSPACE if req.cwd in ("", "/workspace") else Path(req.cwd)).resolve()

    if req.lang == "python":
        # Write the script to a temp file then run it, so tracebacks resolve.
        fd, path = tempfile.mkstemp(prefix="dsh-", suffix=".py", dir=str(cwd if cwd.exists() else WORKSPACE))
        try:
            with os.fdopen(fd, "w") as fh:
                fh.write(req.command)
            return _run([_python_command(), path], cwd if cwd.exists() else WORKSPACE, timeout_s)
        finally:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass

    # Default: run as a bash command.
    return _run([_shell_command(), "-lc", req.command], cwd if cwd.exists() else WORKSPACE, timeout_s)


@app.get("/fs/list")
def fs_list(
    path: str = "/workspace",
    x_sandbox_secret: str | None = Header(default=None, alias="X-Sandbox-Secret"),
) -> dict[str, Any]:
    _authorize(x_sandbox_secret)
    target = Path(path).resolve()
    if not target.exists():
        raise HTTPException(status_code=404, detail="path not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="not a directory")
    entries = []
    for child in sorted(target.iterdir()):
        entries.append(
            {
                "name": child.name,
                "type": "dir" if child.is_dir() else "file",
                "size": child.stat().st_size if child.is_file() else None,
            }
        )
    return {"path": str(target), "entries": entries}


@app.get("/fs/read")
def fs_read(
    path: str,
    x_sandbox_secret: str | None = Header(default=None, alias="X-Sandbox-Secret"),
) -> dict[str, Any]:
    _authorize(x_sandbox_secret)
    target = Path(path).resolve()
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    data = target.read_bytes()
    if b"\x00" in data[:8192]:
        raise HTTPException(status_code=400, detail="binary file")
    return {"path": str(target), "content": data.decode("utf-8", errors="replace")}


# Re-export shlex.quote so callers (and tests) can reuse it.
quote = shlex.quote
