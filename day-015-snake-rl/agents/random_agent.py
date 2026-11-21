"""Uniform random baseline. Every agent exposes the same small interface:

    act(obs, greedy=False) -> int
    observe(obs, action, reward, next_obs, done) -> float | None   (loss, if it learned)
    end_episode() -> None                                           (epsilon decay hook)
    epsilon: float
"""
from __future__ import annotations

import random


class RandomAgent:
    name = "random"

    def __init__(self, n_actions=4, seed=None):
        self.n_actions = n_actions
        self.rng = random.Random(seed)
        self.epsilon = 1.0

    def act(self, obs, greedy=False):
        return self.rng.randrange(self.n_actions)

    def observe(self, obs, action, reward, next_obs, done):
        return None

    def end_episode(self):
        pass

    def save(self, path):
        raise NotImplementedError("the random agent has nothing to save")
