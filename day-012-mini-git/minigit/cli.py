"""Command line entry point: ``python -m minigit <command> ...``."""

from __future__ import annotations

import argparse
import sys

from . import __version__
from .commands import add, plumbing
from .errors import GitError

COMMAND_MODULES = (plumbing, add)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="minigit",
        description="A small Git whose objects, index and refs are byte-compatible with real Git.",
    )
    parser.add_argument("--version", action="version", version=f"minigit {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    for module in COMMAND_MODULES:
        module.register(sub)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help(sys.stderr)
        return 1
    try:
        return args.func(args) or 0
    except GitError as exc:
        sys.stdout.flush()
        print(exc.render(), file=sys.stderr)
        return exc.code
    finally:
        sys.stdout.flush()
