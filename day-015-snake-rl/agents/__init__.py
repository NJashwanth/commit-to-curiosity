"""Agents: random baseline, tabular Q-learning, DQN."""
from agents.qlearn import QLearningAgent
from agents.random_agent import RandomAgent

AGENT_NAMES = ("random", "qlearn", "dqn")


def make_agent(name, **kwargs):
    if name == "random":
        return RandomAgent(**kwargs)
    if name == "qlearn":
        return QLearningAgent(**kwargs)
    if name == "dqn":
        from agents.dqn import DQNAgent  # torch is only imported when needed
        return DQNAgent(**kwargs)
    raise ValueError(f"unknown agent {name!r}, choose from {AGENT_NAMES}")
