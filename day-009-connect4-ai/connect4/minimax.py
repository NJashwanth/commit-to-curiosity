"""Minimax with alpha-beta, a transposition table and iterative deepening.

Scores are negamax style: always from the point of view of the side to
move. A win is worth ``WIN_SCORE - moves``, where ``moves`` is the move
count on the board when the four is made, so faster wins score higher.
Because that number belongs to the position (not to the distance from
the root), cached scores stay valid wherever a position is reached from.
"""

from __future__ import annotations

import time

from .agents import LEVELS, Agent, SearchInfo
from .engine import CELLS, HEIGHT, WIDTH, Board, bit

WIN_SCORE = 1_000_000
MATE_THRESHOLD = WIN_SCORE - CELLS - 1  # any |score| above this is a proven result
INF = WIN_SCORE * 2

# ----- heuristic evaluation ---------------------------------------------------


def _windows() -> tuple[int, ...]:
    """Masks of all 69 lines of four cells on the board."""
    masks = []
    for c in range(WIDTH):
        for r in range(HEIGHT):
            for dc, dr in ((1, 0), (0, 1), (1, 1), (1, -1)):
                cells = [(c + i * dc, r + i * dr) for i in range(4)]
                if all(0 <= x < WIDTH and 0 <= y < HEIGHT for x, y in cells):
                    m = 0
                    for x, y in cells:
                        m |= bit(x, y)
                    masks.append(m)
    return tuple(masks)


WINDOWS = _windows()
CENTER_MASK = sum(bit(3, r) for r in range(HEIGHT))
# Weight of a window holding n pieces of one colour and none of the other.
WINDOW_WEIGHTS = (0, 0, 2, 5)
CENTER_WEIGHT = 3


def evaluate(board: Board) -> int:
    """Static score for the side to move (positive is good for them).

    Every window of four that only one player occupies is worth
    2 (two pieces) or 5 (three pieces) to that player, and each piece in
    the centre column is worth 3, because it takes part in the most lines.
    """
    p = board.current_player
    me = board.bitboards[p]
    opp = board.bitboards[p ^ 1]
    w = WINDOW_WEIGHTS
    score = 0
    for m in WINDOWS:
        a = me & m
        o = opp & m
        if a:
            if not o:
                score += w[a.bit_count()]
        elif o:
            score -= w[o.bit_count()]
    score += CENTER_WEIGHT * ((me & CENTER_MASK).bit_count() - (opp & CENTER_MASK).bit_count())
    return score


def describe_score(score: float, move_count: int) -> str:
    """Human readable score: "+12", "win in 3" or "loss in 2" (own moves)."""
    if score > MATE_THRESHOLD:
        moves = (WIN_SCORE - score - move_count + 1) // 2
        return f"win in {int(moves)}"
    if score < -MATE_THRESHOLD:
        moves = (WIN_SCORE + score - move_count) // 2
        return f"loss in {int(moves)}"
    return f"{score:+d}"


# ----- plain minimax (the reference implementation) -----------------------------


def minimax(board: Board, depth: int) -> tuple[int, int]:
    """Full-width negamax with no pruning. Returns (best move, score).

    Slow on purpose: it exists so tests can check that alpha-beta, with all
    its shortcuts, still returns exactly the same answer.
    """
    best_move, best = -1, -INF
    for col in board.ordered_moves():
        board.play(col)
        if board.winner is not None:
            score = WIN_SCORE - board.move_count
        else:
            score = -_minimax(board, depth - 1)
        board.undo()
        if score > best:
            best_move, best = col, score
    return best_move, best


def _minimax(board: Board, depth: int) -> int:
    if board.move_count == CELLS:
        return 0
    if depth == 0:
        return evaluate(board)
    best = -INF
    for col in board.ordered_moves():
        board.play(col)
        if board.winner is not None:
            score = WIN_SCORE - board.move_count
        else:
            score = -_minimax(board, depth - 1)
        board.undo()
        if score > best:
            best = score
    return best


# ----- transposition table -------------------------------------------------------

EXACT, LOWER, UPPER = 0, 1, 2


class TranspositionTable:
    """Zobrist hash -> (depth, flag, score, best move)."""

    def __init__(self, max_entries: int = 1_000_000) -> None:
        self.max_entries = max_entries
        self.table: dict[int, tuple[int, int, int, int]] = {}
        self.hits = 0

    def get(self, key: int) -> tuple[int, int, int, int] | None:
        return self.table.get(key)

    def store(self, key: int, depth: int, flag: int, score: int, move: int) -> None:
        if len(self.table) >= self.max_entries:
            self.table.clear()  # crude but simple: start over when full
        self.table[key] = (depth, flag, score, move)

    def clear(self) -> None:
        self.table.clear()
        self.hits = 0

    def __len__(self) -> int:
        return len(self.table)


class _Timeout(Exception):
    pass


# ----- the agent -------------------------------------------------------------------


class MinimaxAgent(Agent):
    """Iterative deepening alpha-beta with a transposition table.

    ``depth`` caps the search depth in plies, ``time_limit`` (seconds) stops
    deepening early. The move from the deepest fully searched iteration is
    played. The table is kept between moves and cleared by ``reset``.
    """

    name = "minimax"

    def __init__(
        self,
        depth: int = 6,
        time_limit: float | None = None,
        use_tt: bool = True,
        tt_size: int = 1_000_000,
    ) -> None:
        super().__init__()
        if depth < 1:
            raise ValueError("depth must be at least 1")
        self.max_depth = depth
        self.time_limit = time_limit
        self.use_tt = use_tt
        self.tt = TranspositionTable(tt_size)
        self.nodes = 0
        self._deadline: float | None = None
        self._can_abort = False

    def reset(self) -> None:
        super().reset()
        self.tt.clear()

    def describe(self) -> str:
        limit = f", {self.time_limit:g}s" if self.time_limit else ""
        return f"minimax (depth {self.max_depth}{limit})"

    # -- search ----------------------------------------------------------

    def analyse(self, board: Board) -> SearchInfo:
        start = time.perf_counter()
        board = board.copy()  # a timeout unwinds mid-search; never touch the caller's board
        self.nodes = 0
        hits_before = self.tt.hits
        self._deadline = start + self.time_limit if self.time_limit else None
        self._can_abort = False
        result: tuple[int, int, int] | None = None
        remaining = CELLS - board.move_count
        for depth in range(1, min(self.max_depth, remaining) + 1):
            try:
                move, score = self._root(board, depth)
            except _Timeout:
                break
            result = (move, score, depth)
            self._can_abort = True
            if abs(score) > MATE_THRESHOLD:
                break  # solved: deeper search cannot change a proven result
            if self._deadline and time.perf_counter() >= self._deadline:
                break
        assert result is not None  # depth 1 is never aborted
        move, score, depth = result
        elapsed = time.perf_counter() - start
        return SearchInfo(
            move=move,
            score=score,
            nodes=self.nodes,
            depth=depth,
            elapsed=elapsed,
            extra={
                "tt_hits": self.tt.hits - hits_before,
                "tt_size": len(self.tt),
                "label": describe_score(score, board.move_count),
            },
        )

    def _root(self, board: Board, depth: int) -> tuple[int, int]:
        """Search every root move with a full window, centre first.

        The root order is fixed (no table move first) and only a strictly
        better score replaces the best move, so ties break exactly as in
        plain minimax.
        """
        self.nodes += 1
        n = board.move_count
        moves = board.ordered_moves()
        for col in moves:
            if board.is_winning_move(col):
                return col, WIN_SCORE - (n + 1)
        alpha, beta = -INF, INF
        best_move, best = moves[0], -INF
        for col in moves:
            board.play(col)
            score = -self._alphabeta(board, depth - 1, -beta, -alpha)
            board.undo()
            if score > best:
                best_move, best = col, score
                if best > alpha:
                    alpha = best
        return best_move, best

    def _alphabeta(self, board: Board, depth: int, alpha: int, beta: int) -> int:
        self.nodes += 1
        if (
            self._can_abort
            and self._deadline is not None
            and not self.nodes & 1023
            and time.perf_counter() >= self._deadline
        ):
            raise _Timeout
        n = board.move_count
        if n == CELLS:
            return 0
        if depth == 0:
            return evaluate(board)

        moves = board.ordered_moves()
        for col in moves:
            if board.is_winning_move(col):
                return WIN_SCORE - (n + 1)

        # No win on this move, so the best we can still do is win at move n + 3.
        best_possible = WIN_SCORE - (n + 3)
        if beta > best_possible:
            beta = best_possible
            if alpha >= beta:
                return beta

        key = board.hash
        if self.use_tt:
            entry = self.tt.get(key)
            if entry is not None:
                e_depth, flag, e_score, e_move = entry
                if e_depth >= depth:
                    self.tt.hits += 1
                    if flag == EXACT:
                        return e_score
                    if flag == LOWER:
                        if e_score > alpha:
                            alpha = e_score
                    elif e_score < beta:
                        beta = e_score
                    if alpha >= beta:
                        return e_score
                if e_move in moves and e_move != moves[0]:
                    moves.remove(e_move)
                    moves.insert(0, e_move)

        # Classify the result against the window actually searched.
        alpha_orig = alpha
        best, best_move = -INF, moves[0]
        for col in moves:
            board.play(col)
            score = -self._alphabeta(board, depth - 1, -beta, -alpha)
            board.undo()
            if score > best:
                best, best_move = score, col
                if best > alpha:
                    alpha = best
                    if alpha >= beta:
                        break

        if self.use_tt:
            if best <= alpha_orig:
                flag = UPPER
            elif best >= beta:
                flag = LOWER
            else:
                flag = EXACT
            self.tt.store(key, depth, flag, best, best_move)
        return best


LEVELS["minimax"] = {
    "easy": {"depth": 2},
    "medium": {"depth": 6, "time_limit": 2.0},
    "hard": {"depth": 42, "time_limit": 3.0},
}
