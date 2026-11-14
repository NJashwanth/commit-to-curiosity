"""Monte Carlo Tree Search with UCB1 and random rollouts.

Each iteration walks the tree in four steps:

1. select:      from the root, follow the child with the best UCB1 score
                until reaching a node that still has untried moves
2. expand:      add one child for an untried move
3. rollout:     play uniformly random moves from there to the end
4. backpropagate: walk back up, adding 1 for a win, 0.5 for a draw to
                every node whose mover won

After the budget runs out the most visited root move is played.
"""

from __future__ import annotations

import math
import random
import time

from .agents import LEVELS, Agent, SearchInfo
from .engine import H1, HEIGHT, WIDTH, Board

DEFAULT_ITERATIONS = 1000
EXPLORATION = math.sqrt(2)


class Node:
    __slots__ = ("move", "parent", "children", "untried", "visits", "wins", "player")

    def __init__(self, move: int, parent: "Node | None", player: int, untried: list[int]):
        self.move = move
        self.parent = parent
        self.player = player  # who made ``move`` to reach this node
        self.children: list[Node] = []
        # Popped from the end, so reversed centre order expands the centre first.
        self.untried = untried[::-1]
        self.visits = 0
        self.wins = 0.0  # from the point of view of ``player``

    def ucb1(self, log_parent: float, c: float) -> float:
        return self.wins / self.visits + c * math.sqrt(log_parent / self.visits)

    def best_child(self, c: float) -> "Node":
        log_n = math.log(self.visits)
        return max(self.children, key=lambda ch: ch.ucb1(log_n, c))


class MCTSAgent(Agent):
    """UCB1 tree search. Give it ``iterations``, a ``time_limit``, or both."""

    name = "mcts"

    def __init__(
        self,
        iterations: int | None = DEFAULT_ITERATIONS,
        time_limit: float | None = None,
        exploration: float = EXPLORATION,
        seed: int | None = None,
    ) -> None:
        super().__init__()
        if iterations is None and time_limit is None:
            raise ValueError("give MCTS an iteration budget, a time limit, or both")
        if iterations is not None and iterations < 1:
            raise ValueError("iterations must be at least 1")
        self.iterations = iterations
        self.time_limit = time_limit
        self.exploration = exploration
        self.seed = seed
        self.rng = random.Random(seed)

    def reset(self) -> None:
        super().reset()
        self.rng = random.Random(self.seed)

    def describe(self) -> str:
        parts = []
        if self.iterations is not None:
            parts.append(f"{self.iterations} sims")
        if self.time_limit is not None:
            parts.append(f"{self.time_limit:g}s")
        return f"mcts ({', '.join(parts)})"

    # -- search ----------------------------------------------------------

    def analyse(self, board: Board) -> SearchInfo:
        start = time.perf_counter()
        deadline = start + self.time_limit if self.time_limit else None
        board = board.copy()
        root = Node(-1, None, board.current_player ^ 1, board.ordered_moves())
        c = self.exploration
        sims = 0
        tree = 1
        while self.iterations is None or sims < self.iterations:
            if deadline is not None and sims and time.perf_counter() >= deadline:
                break
            node = root
            depth = 0
            # 1. select
            while not node.untried and node.children:
                node = node.best_child(c)
                board.play(node.move)
                depth += 1
            # 2. expand
            if node.untried:
                move = node.untried.pop()
                player = board.current_player
                board.play(move)
                depth += 1
                child = Node(move, node, player, board.ordered_moves())
                node.children.append(child)
                node = child
                tree += 1
            # 3. rollout
            winner = self._rollout(board)
            # 4. backpropagate
            while node is not None:
                node.visits += 1
                if winner is None:
                    node.wins += 0.5
                elif winner == node.player:
                    node.wins += 1.0
                node = node.parent
            for _ in range(depth):
                board.undo()
            sims += 1

        best = max(root.children, key=lambda ch: ch.visits)
        return SearchInfo(
            move=best.move,
            score=best.wins / best.visits,
            nodes=sims,
            depth=_tree_depth(best) + 1,
            elapsed=time.perf_counter() - start,
            extra={
                "simulations": sims,
                "tree_size": tree,
                "visits": {ch.move: ch.visits for ch in root.children},
                "win_rates": {ch.move: ch.wins / ch.visits for ch in root.children},
                "label": f"{100 * best.wins / best.visits:.0f}% win",
            },
        )

    def _rollout(self, board: Board) -> int | None:
        """Play random moves to the end on scratch bitboards. Returns the winner."""
        if board.winner is not None:
            return board.winner
        bbs = board.bitboards[:]
        heights = board.heights[:]
        cols = [c for c in range(WIDTH) if heights[c] != c * H1 + HEIGHT]
        player = board.current_player
        rand = self.rng.random
        while cols:
            col = cols[int(rand() * len(cols))]
            idx = heights[col]
            b = bbs[player] | (1 << idx)
            bbs[player] = b
            idx += 1
            heights[col] = idx
            if idx == col * H1 + HEIGHT:
                cols.remove(col)
            # Inlined has_four: vertical, horizontal, both diagonals.
            m = b & (b >> 1)
            if m & (m >> 2):
                return player
            m = b & (b >> 7)
            if m & (m >> 14):
                return player
            m = b & (b >> 6)
            if m & (m >> 12):
                return player
            m = b & (b >> 8)
            if m & (m >> 16):
                return player
            player ^= 1
        return None


def _tree_depth(node: Node) -> int:
    """Length of the most visited line below a node."""
    depth = 0
    while node.children:
        node = max(node.children, key=lambda ch: ch.visits)
        depth += 1
    return depth


LEVELS["mcts"] = {
    "easy": {"iterations": 300},
    "medium": {"iterations": 5000},
    "hard": {"iterations": None, "time_limit": 3.0},
}
