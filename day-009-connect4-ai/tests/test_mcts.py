import pytest

from connect4.agents import budget, make_agent
from connect4.engine import Board
from connect4.mcts import MCTSAgent, Node

DRAW_GAME = "547125662261271266215743771576315353334444"


def test_same_seed_gives_identical_searches():
    board = Board.from_moves("4453")
    a = MCTSAgent(iterations=800, seed=7).analyse(board)
    b = MCTSAgent(iterations=800, seed=7).analyse(board)
    assert a.move == b.move
    assert a.score == b.score
    assert a.extra["visits"] == b.extra["visits"]


def test_different_seeds_explore_differently():
    board = Board.from_moves("4453")
    a = MCTSAgent(iterations=800, seed=1).analyse(board)
    b = MCTSAgent(iterations=800, seed=2).analyse(board)
    assert a.extra["visits"] != b.extra["visits"]


def test_reset_restarts_the_random_stream():
    board = Board.from_moves("44")
    agent = MCTSAgent(iterations=300, seed=3)
    first = agent.analyse(board).extra["visits"]
    agent.reset()
    assert agent.analyse(board).extra["visits"] == first


def test_finds_an_immediate_win():
    board = Board.from_moves("717275")  # Red has three stacked in column 7
    info = MCTSAgent(iterations=1000, seed=0).analyse(board)
    assert info.move == 6
    assert info.score == 1.0  # every visit through the winning move is a win
    assert info.extra["label"] == "100% win"
    assert info.depth == 1  # the winning child is terminal


def test_blocks_an_immediate_threat():
    board = Board.from_moves([0, 6, 1, 6, 5, 6])  # Yellow has three in column 7
    assert MCTSAgent(iterations=2000, seed=0).choose_move(board) == 6


def test_visit_counts_add_up_to_the_simulations():
    info = MCTSAgent(iterations=500, seed=4).analyse(Board())
    assert info.nodes == info.extra["simulations"] == 500
    assert sum(info.extra["visits"].values()) == 500
    assert set(info.extra["visits"]) == set(range(7))
    assert info.extra["tree_size"] == 501  # one new node per simulation
    assert 0.0 <= info.score <= 1.0
    assert info.move == max(info.extra["visits"], key=info.extra["visits"].get)


def test_prefers_the_centre_from_the_empty_board():
    assert MCTSAgent(iterations=4000, seed=0).choose_move(Board()) == 3


def test_last_move_rollouts_end_in_a_draw():
    board = Board.from_moves(DRAW_GAME[:-1])
    info = MCTSAgent(iterations=20, seed=0).analyse(board)
    assert info.move == 3
    assert info.score == 0.5


def test_rollout_on_a_finished_board_reports_the_winner():
    agent = MCTSAgent(iterations=1, seed=0)
    assert agent._rollout(Board.from_moves([0, 0, 1, 1, 2, 2, 3])) == 0
    assert agent._rollout(Board.from_moves(DRAW_GAME)) is None


def test_time_budget_stops_the_search():
    info = MCTSAgent(iterations=None, time_limit=0.05, seed=0).analyse(Board())
    assert 0 < info.nodes
    assert info.elapsed < 1.0


def test_time_limit_caps_a_huge_iteration_budget():
    info = MCTSAgent(iterations=10**9, time_limit=0.02, seed=0).analyse(Board())
    assert info.nodes < 10**9
    assert info.elapsed < 1.0


def test_search_leaves_the_board_untouched():
    board = Board.from_moves("4453")
    before = (list(board.bitboards), board.hash, list(board.moves))
    MCTSAgent(iterations=300, seed=0).analyse(board)
    assert (board.bitboards, board.hash, board.moves) == before


def test_needs_some_budget():
    with pytest.raises(ValueError, match="iteration budget"):
        MCTSAgent(iterations=None, time_limit=None)
    with pytest.raises(ValueError, match="at least 1"):
        MCTSAgent(iterations=0)


def test_ucb1_balances_win_rate_and_exploration():
    parent = Node(-1, None, 1, [])
    parent.visits = 100
    good = Node(0, parent, 0, [])
    good.visits, good.wins = 50, 40
    rare = Node(1, parent, 0, [])
    rare.visits, rare.wins = 2, 1
    parent.children = [good, rare]
    # The rarely tried child wins on exploration with the default constant...
    assert parent.best_child(c=1.41) is rare
    # ...and the strong child wins when exploration is switched off.
    assert parent.best_child(c=0.0) is good


def test_describe():
    assert MCTSAgent(iterations=500).describe() == "mcts (500 sims)"
    assert MCTSAgent(iterations=None, time_limit=2).describe() == "mcts (2s)"


def test_mcts_difficulty_budgets():
    assert budget("mcts", "easy") == {"iterations": 300}
    assert budget("mcts", "medium") == {"iterations": 5000}
    assert budget("mcts", "hard") == {"iterations": None, "time_limit": 3.0}


@pytest.mark.parametrize(
    "level, iterations, limit",
    [("easy", 300, None), ("medium", 5000, None), ("hard", None, 3.0)],
)
def test_make_agent_applies_mcts_budget(level, iterations, limit):
    agent = make_agent("mcts", level, seed=5)
    assert isinstance(agent, MCTSAgent)
    assert agent.iterations == iterations and agent.time_limit == limit
    assert agent.seed == 5 and agent.level == level
