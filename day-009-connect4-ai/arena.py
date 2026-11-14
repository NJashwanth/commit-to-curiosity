"""AI vs AI tournament.

    python arena.py --games 100
    python arena.py --games 30 --level hard --agents minimax,mcts
    python arena.py --agents minimax:easy,minimax:hard,mcts
"""

from __future__ import annotations

import argparse
import sys

from connect4.agents import LEVEL_NAMES
from connect4.arena import factories_for, run_arena, save_markdown, to_markdown


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Round-robin Connect Four tournament with Elo.")
    p.add_argument("--games", type=int, default=30, help="total games to play (default 30)")
    p.add_argument("--level", choices=LEVEL_NAMES, default="medium", help="difficulty for every agent")
    p.add_argument(
        "--agents",
        default="random,minimax,mcts",
        help="comma separated agents, optionally name:level (default random,minimax,mcts)",
    )
    p.add_argument("--seed", type=int, default=0, help="base seed for random agents and MCTS")
    p.add_argument("--k", type=float, default=32.0, help="Elo K factor (default 32)")
    p.add_argument("--out", default="results/arena.md", help="markdown report path")
    p.add_argument("--quiet", action="store_true", help="no per-game lines")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.games < 1:
        print("--games must be at least 1", file=sys.stderr)
        return 2
    try:
        factories, descriptions = factories_for(args.agents.split(","), args.level)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    def progress(game, result):
        if args.quiet:
            return
        outcome = "draw" if game.winner is None else f"{game.winner} wins"
        print(
            f"[{game.index + 1:>3}/{args.games}] {game.first} vs {game.second}: "
            f"{outcome} in {len(game.moves)} moves",
            flush=True,
        )

    result = run_arena(
        factories,
        args.games,
        k=args.k,
        seed=args.seed,
        level=args.level,
        descriptions=descriptions,
        on_game=progress,
    )
    report = to_markdown(result)
    path = save_markdown(result, args.out)
    print()
    print(report)
    print(f"Saved {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
