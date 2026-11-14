import random

import pytest

from connect4.agents import budget, make_agent
from connect4.engine import Board
from connect4.minimax import (
    EXACT,
    MATE_THRESHOLD,
    WIN_SCORE,
    WINDOWS,
    MinimaxAgent,
    TranspositionTable,
    describe_score,
    evaluate,
    minimax,
)

# Red (X) to move. Yellow threatens the bottom row at column 4, so Red must
# block there, and that block is also the only move that wins by Red's third
# move. A depth 3 search cannot see the win yet.
#   . . O . . . .
#   . . X . X . .
#   O O O . X X .
FORCED_WIN_IN_3 = "63335152"


def random_positions(count, seed, plies=(4, 14)):
    rng = random.Random(seed)
    positions = []
    while len(positions) < count:
        b = Board()
        for _ in range(rng.randint(*plies)):
            if b.is_over():
                break
            b.play(rng.choice(b.legal_moves()))
        if not b.is_over():
            positions.append(b)
    return positions


# ----- evaluation -------------------------------------------------------------------


def test_there_are_69_windows_of_four():
    assert len(WINDOWS) == 69
    assert all(m.bit_count() == 4 for m in WINDOWS)


def test_evaluation_is_zero_sum_and_favours_the_centre():
    assert evaluate(Board()) == 0
    # Yellow to move in both. A lone Red piece fills no window of two yet,
    # so only the centre bonus counts.
    assert evaluate(Board.from_moves("4")) == -3
    assert evaluate(Board.from_moves("1")) == 0


def test_evaluation_rewards_open_threes():
    # Red to move with three on the bottom row; Yellow has scattered pieces.
    three = Board.from_moves("112237")
    two = Board.from_moves("1122")
    assert evaluate(three) > evaluate(two) == 0  # two is symmetric


def test_describe_score():
    assert describe_score(12, 0) == "+12"
    assert describe_score(-3, 5) == "-3"
    # Side to move with 10 moves on the board wins on move 11: their next move.
    assert describe_score(WIN_SCORE - 11, 10) == "win in 1"
    assert describe_score(WIN_SCORE - 15, 10) == "win in 3"
    # Opponent completes four on move 12: one move from now for them.
    assert describe_score(-(WIN_SCORE - 12), 10) == "loss in 1"


# ----- alpha-beta equals plain minimax --------------------------------------------------


@pytest.mark.parametrize("depth", [1, 2, 3, 4])
def test_alphabeta_matches_plain_minimax(depth):
    for board in random_positions(12, seed=depth):
        expected = minimax(board, depth)
        for use_tt in (True, False):
            info = MinimaxAgent(depth=depth, use_tt=use_tt).analyse(board)
            assert (info.move, info.score) == expected, (repr(board), use_tt)


def test_alphabeta_matches_minimax_on_empty_board():
    assert MinimaxAgent(depth=4).analyse(Board()).move == minimax(Board(), 4)[0] == 3


def test_alphabeta_searches_fewer_nodes_with_pruning_and_table():
    board = Board.from_moves("4453")
    with_tt = MinimaxAgent(depth=7).analyse(board)
    without = MinimaxAgent(depth=7, use_tt=False).analyse(board)
    assert with_tt.score == without.score
    assert with_tt.nodes < without.nodes < 7**7


# ----- tactics --------------------------------------------------------------------------


def test_finds_a_win_in_one():
    board = Board.from_moves("717275")  # Red has three stacked in column 7
    for depth in (1, 2, 5):
        info = MinimaxAgent(depth=depth).analyse(board)
        assert info.move == 6
        assert info.score == WIN_SCORE - 7
        assert info.extra["label"] == "win in 1"


def test_blocks_an_opponent_win_in_one():
    board = Board.from_moves([0, 6, 1, 6, 5, 6])  # Yellow has three in column 7
    for depth in (2, 4, 6):
        assert MinimaxAgent(depth=depth).choose_move(board) == 6


def test_finds_a_forced_win_in_three():
    board = Board.from_moves(FORCED_WIN_IN_3)
    n = board.move_count
    info = MinimaxAgent(depth=5).analyse(board)
    assert info.move == 3
    assert info.score == WIN_SCORE - (n + 5)
    assert info.extra["label"] == "win in 3"
    # Too shallow to see it.
    assert MinimaxAgent(depth=3).analyse(board).score < MATE_THRESHOLD
    # And it really is forced: whatever Yellow replies, Red still wins in 2.
    board.play(3)
    for reply in board.legal_moves():
        board.play(reply)
        assert MinimaxAgent(depth=3).analyse(board).score > MATE_THRESHOLD
        board.undo()


def test_takes_the_win_when_the_opponent_ignores_a_threat():
    board = Board.from_moves(FORCED_WIN_IN_3)
    board.play(0)  # Red ignores the threat, Yellow to move
    info = MinimaxAgent(depth=3).analyse(board)
    assert info.move == 3
    assert info.score == WIN_SCORE - (board.move_count + 1)


def test_sees_a_forced_loss_against_a_double_threat():
    # Yellow has three open at both ends of the bottom row; Red can block one.
    board = Board.from_moves([6, 1, 6, 2, 5, 3])
    info = MinimaxAgent(depth=4).analyse(board)
    assert info.score == -(WIN_SCORE - 8)
    assert info.extra["label"] == "loss in 1"
    assert info.depth == 2  # proven after two plies, so deepening stops


def test_draw_scores_zero_near_full_board():
    board = Board.from_moves("547125662261271266215743771576315353334444"[:-2])
    info = MinimaxAgent(depth=6).analyse(board)
    assert info.score == 0
    assert info.depth == 2  # depth is capped by the empty cells left


# ----- transposition table ----------------------------------------------------------------


def test_transposition_table_store_and_get():
    tt = TranspositionTable(max_entries=2)
    tt.store(1, 3, EXACT, 10, 4)
    assert tt.get(1) == (3, EXACT, 10, 4)
    assert tt.get(2) is None
    tt.store(2, 1, EXACT, 0, 0)
    tt.store(3, 1, EXACT, 0, 0)  # full: table starts over
    assert len(tt) == 1 and tt.get(1) is None
    tt.hits = 5
    tt.clear()
    assert len(tt) == 0 and tt.hits == 0


def test_transposition_table_hits_on_repeated_positions():
    # 4-5-3 and 3-5-4 reach the same position by different move orders.
    agent = MinimaxAgent(depth=6)
    info = agent.analyse(Board())
    assert info.extra["tt_hits"] > 0
    assert info.extra["tt_size"] == len(agent.tt) > 0


def test_repeated_search_reuses_the_table():
    board = Board.from_moves("4453")
    agent = MinimaxAgent(depth=7)
    first = agent.analyse(board)
    second = agent.analyse(board)
    assert second.move == first.move and second.score == first.score
    assert second.nodes < first.nodes
    assert second.extra["tt_hits"] > 0
    agent.reset()
    assert len(agent.tt) == 0


def test_table_off_records_no_hits():
    info = MinimaxAgent(depth=6, use_tt=False).analyse(Board())
    assert info.extra["tt_hits"] == 0 and info.extra["tt_size"] == 0


# ----- iterative deepening and time limit ------------------------------------------------------


def test_iterative_deepening_stops_at_the_time_limit():
    agent = MinimaxAgent(depth=42, time_limit=0.05)
    info = agent.analyse(Board())
    assert 1 <= info.depth < 42
    assert info.elapsed < 1.0
    assert info.move in range(7)


def test_search_stops_deepening_once_solved():
    info = MinimaxAgent(depth=20).analyse(Board.from_moves("717275"))
    assert info.depth == 1


def test_search_leaves_the_board_untouched():
    board = Board.from_moves("4453")
    before = (list(board.bitboards), board.hash, list(board.moves))
    MinimaxAgent(depth=42, time_limit=0.02).analyse(board)
    assert (board.bitboards, board.hash, board.moves) == before


def test_depth_must_be_positive():
    with pytest.raises(ValueError):
        MinimaxAgent(depth=0)


# ----- difficulty levels --------------------------------------------------------------------


def test_minimax_difficulty_budgets():
    assert budget("minimax", "easy") == {"depth": 2}
    assert budget("minimax", "medium") == {"depth": 6, "time_limit": 2.0}
    assert budget("minimax", "hard") == {"depth": 42, "time_limit": 3.0}


@pytest.mark.parametrize(
    "level, depth, limit",
    [("easy", 2, None), ("medium", 6, 2.0), ("hard", 42, 3.0)],
)
def test_make_agent_applies_minimax_budget(level, depth, limit):
    agent = make_agent("minimax", level)
    assert isinstance(agent, MinimaxAgent)
    assert agent.max_depth == depth and agent.time_limit == limit
    assert agent.level == level
    assert agent.describe().startswith(f"minimax (depth {depth}")
