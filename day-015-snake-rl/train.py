"""Train an agent on Snake, log metrics to CSV, keep the best checkpoint, plot curves.

    python train.py --agent qlearn --episodes 2000
    python train.py --agent dqn --episodes 1500 --seed 42
"""
from __future__ import annotations

import argparse
import csv
from collections import deque
from pathlib import Path

from agents import AGENT_NAMES, make_agent
from env import N_FEATURES, SnakeEnv

CSV_FIELDS = ("episode", "score", "avg100", "epsilon", "loss")
CKPT_EXT = {"qlearn": ".npz", "dqn": ".pt"}
COLORS = {"random": "#8a8f98", "qlearn": "#2f6fdb", "dqn": "#e07b00"}


def build_agent(name, env, seed=None, **hp):
    if name == "qlearn":
        if env.state_mode != "compact":
            raise ValueError("tabular Q-learning needs the compact state")
        return make_agent(name, seed=seed, **hp)
    if name == "dqn":
        return make_agent(name, obs_size=env.obs_size, seed=seed, **hp)
    return make_agent(name, seed=seed, **hp)


def env_for(agent, size=12, shaping=True, seed=None):
    """Env matching the agent's input size (compact unless it was built for the grid)."""
    mode = "compact" if getattr(agent, "obs_size", N_FEATURES) == N_FEATURES else "grid"
    return SnakeEnv(size=size, shaping=shaping, state_mode=mode, seed=seed)


def load_agent(name, path, seed=None):
    if name == "qlearn":
        from agents.qlearn import QLearningAgent
        return QLearningAgent.load(path, seed=seed)
    if name == "dqn":
        from agents.dqn import DQNAgent
        return DQNAgent.load(path, seed=seed)
    raise ValueError(f"no checkpoints for agent {name!r}")


def run_episode(env, agent, learn=True, seed=None):
    """Play one episode. Returns (score, steps, mean_loss or None)."""
    obs = env.reset(seed=seed)
    losses, done, info = [], False, {}
    while not done:
        action = agent.act(obs, greedy=not learn)
        nxt, reward, done, info = env.step(action)
        if learn:
            loss = agent.observe(obs, action, reward, nxt, done)
            if loss is not None:
                losses.append(loss)
        obs = nxt
    if learn:
        agent.end_episode()
    return info["score"], info["steps"], (sum(losses) / len(losses) if losses else None)


def evaluate(agent, env, episodes, seed=0):
    """Greedy evaluation: episode i uses env seed ``seed + i`` so agents face identical boards."""
    return [run_episode(env, agent, learn=False, seed=seed + i)[0] for i in range(episodes)]


def train(agent_name, episodes, seed=0, size=12, shaping=True, state_mode="compact", tag=None,
          runs_dir="runs", ckpt_dir="checkpoints", hp=None, log_every=100, quiet=False):
    tag = tag or agent_name
    env = SnakeEnv(size=size, shaping=shaping, state_mode=state_mode, seed=seed)
    agent = build_agent(agent_name, env, seed=seed, **(hp or {}))
    runs_dir, ckpt_dir = Path(runs_dir), Path(ckpt_dir)
    runs_dir.mkdir(parents=True, exist_ok=True)
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    csv_path = runs_dir / f"{tag}.csv"
    ext = CKPT_EXT.get(agent_name)

    window, best, rows = deque(maxlen=100), float("-inf"), []
    with open(csv_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(CSV_FIELDS)
        for ep in range(1, episodes + 1):
            eps = agent.epsilon
            score, _, loss = run_episode(env, agent, learn=True, seed=seed if ep == 1 else None)
            window.append(score)
            avg = sum(window) / len(window)
            row = (ep, score, round(avg, 4), round(eps, 5), "" if loss is None else round(loss, 5))
            writer.writerow(row)
            rows.append(row)
            if ext and len(window) == window.maxlen or ext and ep == episodes:
                if avg > best:
                    best = avg
                    agent.save(ckpt_dir / f"{tag}_best{ext}")
            if not quiet and (ep % log_every == 0 or ep == episodes):
                print(f"[{tag}] ep {ep:5d}  score {score:3d}  avg100 {avg:6.2f}  eps {eps:.3f}"
                      f"  loss {'-' if loss is None else f'{loss:.4f}'}")
    if ext:
        agent.save(ckpt_dir / f"{tag}_last{ext}")
    return {"tag": tag, "csv": csv_path, "best_avg100": best, "rows": rows, "agent": agent}


def read_curve(csv_path):
    with open(csv_path) as fh:
        rows = list(csv.DictReader(fh))
    return [int(r["episode"]) for r in rows], [float(r["avg100"]) for r in rows]


def plot_curves(runs_dir="runs", out="docs/learning_curves.png"):
    """One chart with the avg-of-last-100 curve of every CSV found in ``runs_dir``."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    files = sorted(Path(runs_dir).glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"no CSV logs in {runs_dir}")
    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=150)
    for f in files:
        xs, ys = read_curve(f)
        ax.plot(xs, ys, label=f.stem, color=COLORS.get(f.stem), linewidth=2)
        ax.annotate(f.stem, (xs[-1], ys[-1]), xytext=(4, 0), textcoords="offset points",
                    va="center", fontsize=9, color="#333333")
    ax.set_xlabel("training episode")
    ax.set_ylabel("average score (last 100 episodes)")
    ax.set_title("Snake learning curves")
    ax.grid(alpha=0.25)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(frameon=False, loc="upper left")
    ax.margins(x=0.08)
    fig.tight_layout()
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out)
    plt.close(fig)
    return Path(out)


def parse_hp(items):
    hp = {}
    for item in items or []:
        key, _, val = item.partition("=")
        hp[key] = int(val) if val.lstrip("-").isdigit() else float(val)
    return hp


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--agent", choices=AGENT_NAMES, required=True)
    p.add_argument("--episodes", type=int, default=1000)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--size", type=int, default=12, help="grid size (default 12)")
    p.add_argument("--no-shaping", action="store_true", help="disable the move-toward-food reward")
    p.add_argument("--state", choices=("compact", "grid"), default="compact")
    p.add_argument("--tag", help="name for the CSV and checkpoint (default: agent name)")
    p.add_argument("--hp", action="append", metavar="KEY=VALUE", help="agent hyperparameter, e.g. --hp lr=0.0005")
    p.add_argument("--runs-dir", default="runs")
    p.add_argument("--ckpt-dir", default="checkpoints")
    p.add_argument("--plot", default="docs/learning_curves.png", help="chart path ('' to skip)")
    args = p.parse_args(argv)

    import torch
    torch.set_num_threads(1)
    result = train(args.agent, args.episodes, seed=args.seed, size=args.size, shaping=not args.no_shaping,
                   state_mode=args.state, tag=args.tag, runs_dir=args.runs_dir, ckpt_dir=args.ckpt_dir,
                   hp=parse_hp(args.hp))
    print(f"best avg100 {result['best_avg100']:.2f}  log {result['csv']}")
    if args.plot:
        print(f"chart {plot_curves(args.runs_dir, args.plot)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
