"""Play Connect Four against an AI in the terminal.

    python play.py
    python play.py --ai mcts --level hard
    python play.py --ai minimax --level easy --ai-first
"""

from __future__ import annotations

import argparse

from connect4.agents import LEVEL_NAMES


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Play Connect Four against an AI.")
    p.add_argument("--ai", choices=("minimax", "mcts", "random"), default="minimax")
    p.add_argument("--level", choices=LEVEL_NAMES, default="medium")
    p.add_argument("--ai-first", action="store_true", help="let the AI make the first move")
    p.add_argument("--seed", type=int, default=None, help="seed for MCTS and random")
    return p


def make_app(argv: list[str] | None = None):
    from connect4.tui import Connect4App

    args = build_parser().parse_args(argv)
    return Connect4App(ai=args.ai, level=args.level, human_first=not args.ai_first, seed=args.seed)


if __name__ == "__main__":  # pragma: no cover
    make_app().run()
