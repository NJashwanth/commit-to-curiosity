"""Fixed-capacity experience replay buffer backed by preallocated numpy arrays."""
from __future__ import annotations

import numpy as np


class ReplayBuffer:
    """Ring buffer: once full, the oldest transition is overwritten first."""

    def __init__(self, capacity, obs_size, seed=None):
        if capacity < 1:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self.obs_size = obs_size
        self.states = np.zeros((capacity, obs_size), dtype=np.float32)
        self.actions = np.zeros(capacity, dtype=np.int64)
        self.rewards = np.zeros(capacity, dtype=np.float32)
        self.next_states = np.zeros((capacity, obs_size), dtype=np.float32)
        self.dones = np.zeros(capacity, dtype=np.float32)
        self.pos = 0  # next slot to write
        self.size = 0
        self.rng = np.random.default_rng(seed)

    def __len__(self):
        return self.size

    def push(self, state, action, reward, next_state, done):
        i = self.pos
        self.states[i] = np.asarray(state, dtype=np.float32).reshape(-1)
        self.actions[i] = action
        self.rewards[i] = reward
        self.next_states[i] = np.asarray(next_state, dtype=np.float32).reshape(-1)
        self.dones[i] = float(done)
        self.pos = (self.pos + 1) % self.capacity
        self.size = min(self.size + 1, self.capacity)

    def sample(self, batch_size):
        """Uniform sample without replacement. Returns (s, a, r, s2, done) numpy arrays."""
        if batch_size > self.size:
            raise ValueError(f"cannot sample {batch_size} from a buffer holding {self.size}")
        idx = self.rng.choice(self.size, size=batch_size, replace=False)
        return (self.states[idx], self.actions[idx], self.rewards[idx],
                self.next_states[idx], self.dones[idx])
