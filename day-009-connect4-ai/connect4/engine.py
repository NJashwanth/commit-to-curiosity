"""Connect Four engine on bitboards.

Each player's pieces live in one Python int used as a 64-bit bitboard.
Bit ``col * 7 + row`` is the cell in column ``col`` (0 = left) and row
``row`` (0 = bottom). Every column gets 7 bits: 6 real rows plus an
always-empty sentinel bit on top, which stops horizontal and diagonal
shifts from wrapping into the next column.

    col:   0  1  2  3  4  5  6
    row 6  6 13 20 27 34 41 48   <- sentinel, always 0
    row 5  5 12 19 26 33 40 47
    ...
    row 0  0  7 14 21 28 35 42

Four in a row is found with shifts: ``m = b & (b >> d)`` marks pairs,
``m & (m >> 2d)`` marks fours, for d = 1 (vertical), 7 (horizontal),
6 (diagonal down-right) and 8 (diagonal up-right).
"""

from __future__ import annotations

import random
from typing import Iterable

WIDTH = 7
HEIGHT = 6
H1 = HEIGHT + 1  # bits per column, including the sentinel
CELLS = WIDTH * HEIGHT

# Columns ordered from the centre outwards: the classic move ordering.
CENTER_ORDER = (3, 2, 4, 1, 5, 0, 6)

DIRECTIONS = (1, H1, H1 - 1, H1 + 1)  # vertical, horizontal, two diagonals

BOTTOM_MASK = sum(1 << (c * H1) for c in range(WIDTH))
BOARD_MASK = BOTTOM_MASK * ((1 << HEIGHT) - 1)  # every playable cell

PLAYER_NAMES = ("Red", "Yellow")
PLAYER_SYMBOLS = ("X", "O")


def bit(col: int, row: int) -> int:
    """The single-bit mask for one cell."""
    return 1 << (col * H1 + row)


def has_four(bb: int) -> bool:
    """True if the bitboard contains four in a row in any direction."""
    for d in DIRECTIONS:
        m = bb & (bb >> d)
        if m & (m >> (2 * d)):
            return True
    return False


def four_mask(bb: int) -> int:
    """Every cell that is part of some four in a row on this bitboard."""
    cells = 0
    for d in DIRECTIONS:
        m = bb & (bb >> d)
        starts = m & (m >> (2 * d))
        if starts:
            cells |= starts | (starts << d) | (starts << 2 * d) | (starts << 3 * d)
    return cells


def _zobrist_table() -> tuple[tuple[int, ...], tuple[int, ...]]:
    rng = random.Random(0xC0FFEE)  # fixed so hashes are stable across runs
    size = WIDTH * H1
    return (
        tuple(rng.getrandbits(64) for _ in range(size)),
        tuple(rng.getrandbits(64) for _ in range(size)),
    )


ZOBRIST = _zobrist_table()


class IllegalMoveError(ValueError):
    """Raised when a move cannot be played on the current board."""


class Board:
    """A Connect Four position with make/undo, win detection and a hash.

    Player 0 (Red, ``X``) always moves first. ``current_player`` is derived
    from the number of moves played, so it never needs storing.
    """

    __slots__ = ("bitboards", "heights", "moves", "hash", "winner")

    def __init__(self) -> None:
        self.bitboards = [0, 0]
        # heights[c] is the bit index of the next free cell in column c.
        self.heights = [c * H1 for c in range(WIDTH)]
        self.moves: list[int] = []
        self.hash = 0
        self.winner: int | None = None

    # ----- construction -------------------------------------------------

    @classmethod
    def from_moves(cls, moves: Iterable[int] | str) -> "Board":
        """Build a board by replaying moves.

        A string is read as 1-based column digits ("4453" means columns
        3, 3, 4, 2), matching the keys used in the TUI. Any other iterable
        is read as 0-based column numbers.
        """
        board = cls()
        if isinstance(moves, str):
            cols = [int(ch) - 1 for ch in moves if not ch.isspace()]
        else:
            cols = list(moves)
        for col in cols:
            board.play(col)
        return board

    def copy(self) -> "Board":
        other = Board.__new__(Board)
        other.bitboards = self.bitboards[:]
        other.heights = self.heights[:]
        other.moves = self.moves[:]
        other.hash = self.hash
        other.winner = self.winner
        return other

    # ----- queries --------------------------------------------------------

    @property
    def current_player(self) -> int:
        return len(self.moves) & 1

    @property
    def move_count(self) -> int:
        return len(self.moves)

    def can_play(self, col: int) -> bool:
        return 0 <= col < WIDTH and self.heights[col] != col * H1 + HEIGHT

    def legal_moves(self) -> list[int]:
        """Playable columns left to right; empty once the game is over."""
        if self.winner is not None:
            return []
        return [c for c in range(WIDTH) if self.heights[c] != c * H1 + HEIGHT]

    def ordered_moves(self) -> list[int]:
        """Playable columns, centre first."""
        if self.winner is not None:
            return []
        h = self.heights
        return [c for c in CENTER_ORDER if h[c] != c * H1 + HEIGHT]

    def is_winning_move(self, col: int) -> bool:
        """Would playing ``col`` win immediately for the side to move?"""
        if not self.can_play(col) or self.winner is not None:
            return False
        bb = self.bitboards[self.current_player] | (1 << self.heights[col])
        return has_four(bb)

    def is_draw(self) -> bool:
        return self.winner is None and len(self.moves) == CELLS

    def is_over(self) -> bool:
        return self.winner is not None or len(self.moves) == CELLS

    def cell(self, col: int, row: int) -> int | None:
        """0 or 1 for the owner of a cell, None if it is empty."""
        b = bit(col, row)
        if self.bitboards[0] & b:
            return 0
        if self.bitboards[1] & b:
            return 1
        return None

    def column_height(self, col: int) -> int:
        """Number of pieces already in a column."""
        return self.heights[col] - col * H1

    def winning_cells(self) -> list[tuple[int, int]]:
        """(col, row) of every cell in the winning line(s), or [] if no win."""
        if self.winner is None:
            return []
        mask = four_mask(self.bitboards[self.winner])
        return [
            (c, r)
            for c in range(WIDTH)
            for r in range(HEIGHT)
            if mask & bit(c, r)
        ]

    def key(self) -> tuple[int, int]:
        """Exact, collision-free identity of the position."""
        return (self.bitboards[0], self.bitboards[1])

    # ----- make / undo ----------------------------------------------------

    def play(self, col: int) -> None:
        """Drop a piece for the side to move into ``col`` (0-based)."""
        if not isinstance(col, int) or isinstance(col, bool):
            raise IllegalMoveError(f"column must be an int, got {col!r}")
        if not 0 <= col < WIDTH:
            raise IllegalMoveError(
                f"column {col} is out of range (expected 0-{WIDTH - 1})"
            )
        if self.winner is not None:
            raise IllegalMoveError("the game is already over")
        idx = self.heights[col]
        if idx == col * H1 + HEIGHT:
            raise IllegalMoveError(f"column {col} is full")
        player = len(self.moves) & 1
        bb = self.bitboards[player] | (1 << idx)
        self.bitboards[player] = bb
        self.heights[col] = idx + 1
        self.moves.append(col)
        self.hash ^= ZOBRIST[player][idx]
        if has_four(bb):
            self.winner = player

    def undo(self) -> int:
        """Take back the last move and return its column."""
        if not self.moves:
            raise IllegalMoveError("there is no move to undo")
        col = self.moves.pop()
        idx = self.heights[col] - 1
        player = len(self.moves) & 1
        self.heights[col] = idx
        self.bitboards[player] ^= 1 << idx
        self.hash ^= ZOBRIST[player][idx]
        self.winner = None  # a game only ends on its last move
        return col

    # ----- display --------------------------------------------------------

    def __str__(self) -> str:
        rows = []
        for r in range(HEIGHT - 1, -1, -1):
            cells = []
            for c in range(WIDTH):
                owner = self.cell(c, r)
                cells.append("." if owner is None else PLAYER_SYMBOLS[owner])
            rows.append(" ".join(cells))
        rows.append(" ".join(str(c + 1) for c in range(WIDTH)))
        return "\n".join(rows)

    def __repr__(self) -> str:
        seq = "".join(str(c + 1) for c in self.moves)
        return f"Board.from_moves({seq!r})"
