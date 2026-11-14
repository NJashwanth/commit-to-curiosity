import pytest

from connect4.agents import LEVEL_NAMES, LEVELS, RandomAgent, budget, make_agent
from connect4.engine import Board


def test_random_agent_plays_legal_moves_and_leaves_board_alone():
    agent = RandomAgent(seed=1)
    board = Board.from_moves([3] * 6)  # column 3 full
    for _ in range(50):
        before = (list(board.bitboards), board.hash)
        move = agent.choose_move(board)
        assert move in board.legal_moves() and move != 3
        assert (board.bitboards, board.hash) == before
    assert agent.last_info.nodes == 1


def test_random_agent_is_deterministic_with_a_seed():
    board = Board()
    a = [RandomAgent(seed=42).choose_move(board) for _ in range(5)]
    b = [RandomAgent(seed=42).choose_move(board) for _ in range(5)]
    assert a == b


def test_agent_refuses_finished_games():
    board = Board.from_moves([0, 0, 1, 1, 2, 2, 3])
    with pytest.raises(ValueError, match="game is over"):
        RandomAgent(seed=0).choose_move(board)


def test_reset_clears_last_info():
    agent = RandomAgent(seed=0)
    agent.choose_move(Board())
    agent.reset()
    assert agent.last_info is None
    assert agent.describe() == "random"


def test_every_agent_has_every_level():
    for agent, levels in LEVELS.items():
        assert tuple(levels) == LEVEL_NAMES, agent


def test_budget_rejects_unknown_names():
    with pytest.raises(ValueError, match="unknown agent"):
        budget("alphazero", "easy")
    with pytest.raises(ValueError, match="unknown level"):
        budget("random", "nightmare")


def test_budget_returns_a_copy():
    budget("random", "easy")["oops"] = 1
    assert "oops" not in LEVELS["random"]["easy"]


def test_make_random_agent():
    agent = make_agent("random", "hard", seed=3)
    assert isinstance(agent, RandomAgent)
    assert agent.level == "hard"
