"""Snake environment with a gym-style API (reset, step, render).

Grid coordinates are (x, y) with x growing to the right and y growing down.
Actions are absolute directions: 0=UP, 1=RIGHT, 2=DOWN, 3=LEFT. Asking to
reverse into the snake's own neck is ignored and the snake keeps going straight.
"""
from __future__ import annotations

import random
from collections import deque

import numpy as np

UP, RIGHT, DOWN, LEFT = 0, 1, 2, 3
DELTAS = ((0, -1), (1, 0), (0, 1), (-1, 0))
N_ACTIONS = 4
N_FEATURES = 11
FEATURE_NAMES = (
    "danger_straight", "danger_right", "danger_left",
    "dir_up", "dir_right", "dir_down", "dir_left",
    "food_up", "food_right", "food_down", "food_left",
)

FOOD_REWARD = 10.0
DEATH_REWARD = -10.0
SHAPING_REWARD = 0.1


def _blocked(size, body, cell):
    x, y = cell
    return not (0 <= x < size and 0 <= y < size) or cell in body


def compact_features(size, snake, direction, food):
    """11 binary features: danger straight/right/left (relative to heading),
    current heading one-hot (up/right/down/left), food up/right/down/left of the head.

    ``snake`` is ordered head first. The tail cell is not a danger because it
    moves away on the same tick (food never sits on the tail, so no growth there).
    """
    head = snake[0]
    body = set(list(snake)[:-1])
    feats = []
    for turn in (0, 1, -1):  # straight, right, left
        dx, dy = DELTAS[(direction + turn) % 4]
        feats.append(_blocked(size, body, (head[0] + dx, head[1] + dy)))
    feats.extend(direction == d for d in (UP, RIGHT, DOWN, LEFT))
    feats.extend((food[1] < head[1], food[0] > head[0], food[1] > head[1], food[0] < head[0]))
    return np.array(feats, dtype=np.float32)


class SnakeEnv:
    """Seeded Snake. ``state_mode`` is "compact" (11 features) or "grid" (3xHxW)."""

    n_actions = N_ACTIONS

    def __init__(self, size=12, shaping=True, state_mode="compact", max_idle_steps=None, seed=None):
        if size < 5:
            raise ValueError("grid must be at least 5x5")
        if state_mode not in ("compact", "grid"):
            raise ValueError("state_mode must be 'compact' or 'grid'")
        self.size = size
        self.shaping = shaping
        self.state_mode = state_mode
        self.max_idle_steps = max_idle_steps if max_idle_steps is not None else size * size
        self.rng = random.Random(seed)
        self.snake = deque()
        self.direction = RIGHT
        self.food = (0, 0)
        self.score = 0
        self.steps = 0
        self.idle = 0
        self.done = True

    @property
    def obs_size(self):
        return N_FEATURES if self.state_mode == "compact" else 3 * self.size * self.size

    # -- lifecycle ---------------------------------------------------------
    def reset(self, seed=None):
        if seed is not None:
            self.rng = random.Random(seed)
        mid = self.size // 2
        self.snake = deque([(mid, mid), (mid - 1, mid), (mid - 2, mid)])
        self.direction = RIGHT
        self.score = self.steps = self.idle = 0
        self.done = False
        self.food = self._spawn_food()
        return self._obs()

    def set_state(self, snake, direction, food):
        """Place a crafted position (head first). Used by tests and demos."""
        self.snake = deque(tuple(c) for c in snake)
        self.direction = direction
        self.food = tuple(food)
        self.score = self.steps = self.idle = 0
        self.done = False
        return self._obs()

    def _spawn_food(self):
        occupied = set(self.snake)
        free = [(x, y) for y in range(self.size) for x in range(self.size) if (x, y) not in occupied]
        return self.rng.choice(free) if free else None

    # -- dynamics ----------------------------------------------------------
    def step(self, action):
        if self.done:
            raise RuntimeError("episode is over, call reset()")
        if action not in range(N_ACTIONS):
            raise ValueError(f"invalid action {action!r}")
        if (action + 2) % 4 != self.direction:  # reversing is ignored
            self.direction = action
        dx, dy = DELTAS[self.direction]
        head = self.snake[0]
        new = (head[0] + dx, head[1] + dy)
        ate = new == self.food
        self.steps += 1
        reason = None
        reward = 0.0

        body = set(self.snake) if ate else set(list(self.snake)[:-1])
        if not (0 <= new[0] < self.size and 0 <= new[1] < self.size):
            reason = "wall"
        elif new in body:
            reason = "self"

        if reason is None:
            old_dist = abs(head[0] - self.food[0]) + abs(head[1] - self.food[1])
            self.snake.appendleft(new)
            if ate:
                self.score += 1
                self.idle = 0
                reward = FOOD_REWARD
                self.food = self._spawn_food()
                if self.food is None:
                    reason = "won"
            else:
                self.snake.pop()
                self.idle += 1
                if self.shaping:
                    new_dist = abs(new[0] - self.food[0]) + abs(new[1] - self.food[1])
                    reward = SHAPING_REWARD if new_dist < old_dist else -SHAPING_REWARD
                if self.idle >= self.max_idle_steps:
                    reason = "starved"
        if reason in ("wall", "self", "starved"):
            reward = DEATH_REWARD
        self.done = reason is not None
        info = {"score": self.score, "steps": self.steps, "reason": reason, "ate": ate}
        return self._obs(), reward, self.done, info

    # -- observations / rendering -----------------------------------------
    def _obs(self):
        if self.food is None:  # board is full, nothing left to look for
            return np.zeros(self.obs_size, dtype=np.float32) if self.state_mode == "compact" else \
                np.zeros((3, self.size, self.size), dtype=np.float32)
        if self.state_mode == "compact":
            return compact_features(self.size, self.snake, self.direction, self.food)
        grid = np.zeros((3, self.size, self.size), dtype=np.float32)
        for x, y in list(self.snake)[1:]:
            grid[0, y, x] = 1.0
        hx, hy = self.snake[0]
        grid[1, hy, hx] = 1.0
        grid[2, self.food[1], self.food[0]] = 1.0
        return grid

    def snapshot(self):
        return {"size": self.size, "snake": list(self.snake), "food": self.food, "score": self.score}

    def render(self):
        """ASCII board: O head, o body, * food, . empty."""
        rows = [["."] * self.size for _ in range(self.size)]
        for i, (x, y) in enumerate(self.snake):
            rows[y][x] = "O" if i == 0 else "o"
        if self.food is not None:
            rows[self.food[1]][self.food[0]] = "*"
        return "\n".join(" ".join(r) for r in rows)
