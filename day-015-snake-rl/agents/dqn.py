"""Deep Q-Network: small MLP, replay buffer, target network, Huber loss, Adam.

    loss = Huber( Q_online(s, a),  r + gamma * (1 - done) * max_a' Q_target(s', a') )

The target network is a frozen copy of the online network, re-synced every
``target_sync`` gradient steps so the regression target does not chase itself.
"""
from __future__ import annotations

import random

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from replay import ReplayBuffer

CONFIG_KEYS = ("obs_size", "n_actions", "hidden", "lr", "gamma", "batch_size", "buffer_size",
               "target_sync", "learn_start", "eps_start", "eps_min", "eps_decay")


def build_mlp(obs_size, n_actions, hidden):
    return nn.Sequential(
        nn.Linear(obs_size, hidden), nn.ReLU(),
        nn.Linear(hidden, hidden), nn.ReLU(),
        nn.Linear(hidden, n_actions),
    )


class DQNAgent:
    name = "dqn"

    def __init__(self, obs_size=11, n_actions=4, hidden=64, lr=1e-3, gamma=0.9, batch_size=64,
                 buffer_size=20000, target_sync=200, learn_start=500,
                 eps_start=1.0, eps_min=0.01, eps_decay=0.995, seed=None):
        self.config = dict(obs_size=obs_size, n_actions=n_actions, hidden=hidden, lr=lr, gamma=gamma,
                           batch_size=batch_size, buffer_size=buffer_size, target_sync=target_sync,
                           learn_start=learn_start, eps_start=eps_start, eps_min=eps_min,
                           eps_decay=eps_decay)
        self.obs_size, self.n_actions, self.gamma = obs_size, n_actions, gamma
        self.batch_size, self.target_sync = batch_size, target_sync
        self.learn_start = max(learn_start, batch_size)
        self.eps_min, self.eps_decay = eps_min, eps_decay
        self.epsilon = eps_start
        self.episodes = 0
        self.learn_steps = 0
        self.rng = random.Random(seed)
        if seed is not None:
            torch.manual_seed(seed)
        self.online = build_mlp(obs_size, n_actions, hidden)
        self.target = build_mlp(obs_size, n_actions, hidden)
        self.target.load_state_dict(self.online.state_dict())
        self.target.requires_grad_(False)
        self.optimizer = torch.optim.Adam(self.online.parameters(), lr=lr)
        self.buffer = ReplayBuffer(buffer_size, obs_size, seed=seed)

    # -- acting ------------------------------------------------------------
    def q_values(self, obs):
        x = torch.as_tensor(np.asarray(obs, dtype=np.float32).reshape(1, -1))
        with torch.no_grad():
            return self.online(x)[0]

    def act(self, obs, greedy=False):
        if not greedy and self.rng.random() < self.epsilon:
            return self.rng.randrange(self.n_actions)
        return int(self.q_values(obs).argmax())

    # -- learning ----------------------------------------------------------
    def observe(self, obs, action, reward, next_obs, done):
        """Store the transition and, once warmed up, take one gradient step. Returns the loss."""
        self.buffer.push(obs, action, reward, next_obs, done)
        if len(self.buffer) < self.learn_start:
            return None
        return self.learn()

    def td_targets(self, rewards, next_states, dones):
        """r + gamma * max_a' Q_target(s', a'), with the bootstrap term zeroed on terminal steps."""
        with torch.no_grad():
            next_q = self.target(next_states).max(dim=1).values
        return rewards + self.gamma * (1.0 - dones) * next_q

    def learn(self):
        s, a, r, s2, d = (torch.as_tensor(x) for x in self.buffer.sample(self.batch_size))
        q = self.online(s).gather(1, a.unsqueeze(1)).squeeze(1)
        loss = F.smooth_l1_loss(q, self.td_targets(r, s2, d))
        self.optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.online.parameters(), 10.0)
        self.optimizer.step()
        self.learn_steps += 1
        if self.learn_steps % self.target_sync == 0:
            self.sync_target()
        return loss.item()

    def sync_target(self):
        self.target.load_state_dict(self.online.state_dict())

    def end_episode(self):
        self.episodes += 1
        self.epsilon = max(self.eps_min, self.epsilon * self.eps_decay)

    # -- checkpoints -------------------------------------------------------
    def save(self, path):
        torch.save({"config": self.config, "online": self.online.state_dict(),
                    "target": self.target.state_dict(), "epsilon": self.epsilon,
                    "episodes": self.episodes, "learn_steps": self.learn_steps}, path)

    @classmethod
    def load(cls, path, seed=None):
        ckpt = torch.load(path, map_location="cpu", weights_only=True)
        agent = cls(seed=seed, **ckpt["config"])
        agent.online.load_state_dict(ckpt["online"])
        agent.target.load_state_dict(ckpt["target"])
        agent.epsilon = ckpt["epsilon"]
        agent.episodes = ckpt["episodes"]
        agent.learn_steps = ckpt["learn_steps"]
        return agent
