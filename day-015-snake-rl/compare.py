"""Evaluate random vs Q-learning vs DQN greedily and print a score table.

    python compare.py --episodes 200
"""
from __future__ import annotations

import argparse
import statistics
from pathlib import Path

from train import CKPT_EXT, env_for, evaluate, load_agent
from agents import make_agent

AGENTS = ("random", "qlearn", "dqn")


def summarize(scores):
    return {"mean": statistics.fmean(scores), "median": statistics.median(scores), "max": max(scores)}


def compare(episodes=200, seed=1000, size=12, ckpt_dir="checkpoints", shaping=True, agents=AGENTS):
    """Returns {agent: stats}. Every agent plays the same seeded boards."""
    results = {}
    for name in agents:
        if name == "random":
            agent = make_agent("random", seed=seed)
        else:
            path = Path(ckpt_dir) / f"{name}_best{CKPT_EXT[name]}"
            if not path.exists():
                raise FileNotFoundError(f"{path} not found, run: python train.py --agent {name}")
            agent = load_agent(name, path)
        env = env_for(agent, size=size, shaping=shaping)
        results[name] = summarize(evaluate(agent, env, episodes, seed=seed))
    return results


def markdown_table(results, episodes):
    lines = ["| Agent | Mean | Median | Max |", "|---|---:|---:|---:|"]
    for name, s in results.items():
        lines.append(f"| {name} | {s['mean']:.2f} | {s['median']:.1f} | {s['max']} |")
    return "\n".join(lines)


def print_table(results, episodes):
    from rich.console import Console
    from rich.table import Table

    table = Table(title=f"Greedy evaluation, {episodes} episodes")
    table.add_column("Agent")
    for col in ("Mean", "Median", "Max"):
        table.add_column(col, justify="right")
    for name, s in results.items():
        table.add_row(name, f"{s['mean']:.2f}", f"{s['median']:.1f}", str(s["max"]))
    Console().print(table)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--episodes", type=int, default=200)
    p.add_argument("--seed", type=int, default=1000)
    p.add_argument("--size", type=int, default=12)
    p.add_argument("--ckpt-dir", default="checkpoints")
    p.add_argument("--markdown", help="also write the table to this .md file")
    args = p.parse_args(argv)

    import torch
    torch.set_num_threads(1)
    try:
        results = compare(args.episodes, args.seed, args.size, args.ckpt_dir)
    except FileNotFoundError as err:
        print(err)
        return 1
    print_table(results, args.episodes)
    if args.markdown:
        Path(args.markdown).parent.mkdir(parents=True, exist_ok=True)
        Path(args.markdown).write_text(markdown_table(results, args.episodes) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
