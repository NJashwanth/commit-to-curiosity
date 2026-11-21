"""Agents: random baseline, tabular Q-learning, DQN."""
from agents.qlearn import QLearningAgent
from agents.random_agent import RandomAgent

AGENT_NAMES = ("random", "qlearn")


def make_agent(name, **kwargs):
    if name == "random":
        return RandomAgent(**kwargs)
    if name == "qlearn":
        return QLearningAgent(**kwargs)
    raise ValueError(f"unknown agent {name!r}, choose from {AGENT_NAMES}")
