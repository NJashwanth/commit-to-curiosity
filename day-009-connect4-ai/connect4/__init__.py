"""connect4-ai: a bitboard Connect Four engine with minimax and MCTS agents."""

from .engine import Board, IllegalMoveError

__all__ = ["Board", "IllegalMoveError"]
__version__ = "0.1.0"
