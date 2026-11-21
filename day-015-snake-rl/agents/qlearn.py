"""Tabular Q-learning over the compact 11-feature state.

The 11 binary features are packed into one integer, so the Q-table is a plain
(2**11, n_actions) array. Update rule (Bellman, off-policy):

    Q(s,a) <- Q(s,a) + alpha * (r + gamma * max_a' Q(s',a') - Q(s,a))
"""
from __future__ import annotations

import random

import numpy as np


class QLearningAgent:
    name = "qlearn"

    def __init__(self, n_actions=4, n_features=11, alpha=0.1, gamma=0.9,
                 eps_start=1.0, eps_min=0.01, eps_decay=0.995, seed=None):
        self.n_actions = n_actions
        self.n_features = n_features
        self.alpha = alpha
        self.gamma = gamma
        self.eps_start = eps_start
        self.eps_min = eps_min
        self.eps_decay = eps_decay
        self.epsilon = eps_start
        self.episodes = 0
        self.rng = random.Random(seed)
        self.q = np.zeros((2 ** n_features, n_actions), dtype=np.float64)
        self._bits = 1 << np.arange(n_features)

    def state_index(self, obs):
        return int(np.dot(np.asarray(obs) > 0.5, self._bits))

    def act(self, obs, greedy=False):
        if not greedy and self.rng.random() < self.epsilon:
            return self.rng.randrange(self.n_actions)
        return int(np.argmax(self.q[self.state_index(obs)]))

    def observe(self, obs, action, reward, next_obs, done):
        """One Q-learning update. Returns the squared TD error (used as the logged loss)."""
        s, s2 = self.state_index(obs), self.state_index(next_obs)
        target = reward if done else reward + self.gamma * self.q[s2].max()
        td_error = target - self.q[s, action]
        self.q[s, action] += self.alpha * td_error
        return float(td_error ** 2)

    def end_episode(self):
        """Exponential epsilon decay once per episode, floored at eps_min."""
        self.episodes += 1
        self.epsilon = max(self.eps_min, self.epsilon * self.eps_decay)

    def save(self, path):
        np.savez(path, q=self.q, epsilon=self.epsilon, episodes=self.episodes,
                 hyper=np.array([self.alpha, self.gamma, self.eps_start, self.eps_min, self.eps_decay]))

    @classmethod
    def load(cls, path, seed=None):
        data = np.load(path)
        alpha, gamma, eps_start, eps_min, eps_decay = data["hyper"].tolist()
        q = data["q"]
        agent = cls(n_actions=q.shape[1], n_features=int(np.log2(q.shape[0])), alpha=alpha, gamma=gamma,
                    eps_start=eps_start, eps_min=eps_min, eps_decay=eps_decay, seed=seed)
        agent.q = q
        agent.epsilon = float(data["epsilon"])
        agent.episodes = int(data["episodes"])
        return agent
