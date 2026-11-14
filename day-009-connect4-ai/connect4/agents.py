"""Agent interface, the random baseline, and difficulty levels."""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field

from .engine import Board

LEVEL_NAMES = ("easy", "medium", "hard")


@dataclass
class SearchInfo:
    """What an agent decided and how hard it worked for it.

    ``score`` is from the point of view of the side that was to move:
    minimax reports its evaluation, MCTS the chosen move's win rate.
    """

    move: int
    score: float = 0.0
    nodes: int = 0
    depth: int = 0
    elapsed: float = 0.0
    extra: dict = field(default_factory=dict)


class Agent:
    """Base class. Subclasses implement :meth:`analyse`."""

    name = "agent"

    def __init__(self) -> None:
        self.last_info: SearchInfo | None = None

    def analyse(self, board: Board) -> SearchInfo:  # pragma: no cover - abstract
        raise NotImplementedError

    def choose_move(self, board: Board) -> int:
        """Pick a move. The board is left exactly as it was passed in."""
        if board.is_over():
            raise ValueError("cannot choose a move: the game is over")
        info = self.analyse(board)
        self.last_info = info
        return info.move

    def reset(self) -> None:
        """Forget anything carried between moves (called on a new game)."""
        self.last_info = None

    def describe(self) -> str:
        return self.name


class RandomAgent(Agent):
    """Uniformly random legal moves: the baseline every AI must beat."""

    name = "random"

    def __init__(self, seed: int | None = None) -> None:
        super().__init__()
        self.rng = random.Random(seed)

    def analyse(self, board: Board) -> SearchInfo:
        start = time.perf_counter()
        move = self.rng.choice(board.legal_moves())
        return SearchInfo(move=move, nodes=1, elapsed=time.perf_counter() - start)


# Difficulty levels map to search budgets. Each agent module registers its
# own row; ``make_agent`` turns (name, level) into a configured agent.
LEVELS: dict[str, dict[str, dict]] = {
    "random": {"easy": {}, "medium": {}, "hard": {}},
}


def budget(agent: str, level: str) -> dict:
    """The keyword arguments a difficulty level gives an agent."""
    from . import minimax  # noqa: F401  (registers its levels)

    if agent not in LEVELS:
        raise ValueError(f"unknown agent {agent!r} (choose from {', '.join(LEVELS)})")
    if level not in LEVEL_NAMES:
        raise ValueError(f"unknown level {level!r} (choose from {', '.join(LEVEL_NAMES)})")
    return dict(LEVELS[agent][level])


def make_agent(name: str, level: str = "medium", seed: int | None = None) -> Agent:
    """Build an agent by name at a difficulty level."""
    from . import minimax  # noqa: F401  (imported here to register levels)

    kwargs = budget(name, level)
    if name == "minimax":
        agent: Agent = minimax.MinimaxAgent(**kwargs)
    else:
        agent = RandomAgent(seed=seed)
    agent.level = level  # type: ignore[attr-defined]
    return agent
