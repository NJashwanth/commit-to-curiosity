"""Run mini-git in-process (so coverage sees it) and real git as a subprocess (the oracle)."""

from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from minigit import cli


@dataclass
class Result:
    code: int
    out: bytes
    err: str

    @property
    def text(self) -> str:
        return self.out.decode("utf-8", "surrogateescape")


def mg(cwd, *args: str, stdin: bytes = b"", env: dict | None = None, check: bool = True) -> Result:
    """Run ``python -m minigit <args>`` inside this process, in directory ``cwd``."""
    stdout = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", write_through=True)
    stderr = io.StringIO()
    fake_stdin = io.TextIOWrapper(io.BytesIO(stdin), encoding="utf-8")
    saved_cwd, saved_env = os.getcwd(), dict(os.environ)
    os.chdir(cwd)
    os.environ.update(env or {})
    saved_stdin, sys.stdin = sys.stdin, fake_stdin
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                code = cli.main(list(args))
            except SystemExit as exc:  # argparse usage errors
                code = exc.code if isinstance(exc.code, int) else 1
        stdout.flush()
    finally:
        sys.stdin = saved_stdin
        os.chdir(saved_cwd)
        os.environ.clear()
        os.environ.update(saved_env)
    result = Result(code, stdout.buffer.getvalue(), stderr.getvalue())
    if check and code != 0:
        raise AssertionError(f"minigit {' '.join(args)} exited {code}:\n{result.err}")
    return result


def git(cwd, *args: str, stdin: bytes | None = None, env: dict | None = None, check: bool = True):
    """Run the real git binary. Returns the CompletedProcess (stdout/stderr as bytes)."""
    full_env = {**os.environ, **(env or {})}
    proc = subprocess.run(
        ["git", "-c", "init.defaultBranch=main", *args],
        cwd=cwd,
        input=stdin,
        capture_output=True,
        env=full_env,
    )
    if check and proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} exited {proc.returncode}:\n{proc.stderr.decode()}")
    return proc


def git_out(cwd, *args: str, **kw) -> str:
    return git(cwd, *args, **kw).stdout.decode("utf-8", "surrogateescape")


def write_file(root: Path, rel: str, content: bytes | str = b"", executable: bool = False) -> Path:
    path = Path(root) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)
    path.chmod(0o755 if executable else 0o644)
    return path
