"""Replay a trained agent: animated GIF and/or live in the terminal.

    python watch.py --agent dqn --gif docs/dqn.gif
    python watch.py --agent dqn --terminal
"""
from __future__ import annotations

import argparse
from pathlib import Path

from agents import AGENT_NAMES
from render import record_episode, save_gif, watch_terminal
from train import agent_from_checkpoint, env_for


def best_episode(agent, env, seed, best_of):
    """Record ``best_of`` greedy episodes (seeds seed, seed+1, ...) and keep the highest scoring one."""
    runs = [record_episode(agent, env, seed=seed + i) for i in range(best_of)]
    return max(runs, key=lambda frames: frames[-1]["score"])


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--agent", choices=AGENT_NAMES, required=True)
    p.add_argument("--gif", help="write an animated GIF to this path")
    p.add_argument("--terminal", action="store_true", help="play live in the terminal")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--best-of", type=int, default=1, help="record N episodes and keep the best (default 1)")
    p.add_argument("--size", type=int, default=12)
    p.add_argument("--fps", type=int, default=12)
    p.add_argument("--cell", type=int, default=20, help="GIF cell size in pixels")
    p.add_argument("--ckpt-dir", default="checkpoints")
    args = p.parse_args(argv)
    if not (args.gif or args.terminal):
        p.error("choose --gif PATH and/or --terminal")

    try:
        agent = agent_from_checkpoint(args.agent, args.ckpt_dir, seed=args.seed)
    except FileNotFoundError as err:
        print(err)
        return 1
    env = env_for(agent, size=args.size)
    frames = best_episode(agent, env, args.seed, args.best_of)
    print(f"{args.agent}: score {frames[-1]['score']} in {len(frames) - 1} steps")
    if args.gif:
        Path(args.gif).parent.mkdir(parents=True, exist_ok=True)
        save_gif(frames, args.gif, fps=args.fps, cell=args.cell)
        print(f"wrote {args.gif} ({Path(args.gif).stat().st_size / 1e6:.2f} MB, {len(frames)} frames)")
    if args.terminal:
        watch_terminal(frames, fps=args.fps)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
