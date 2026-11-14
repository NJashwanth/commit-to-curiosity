import random

import pytest

from connect4.engine import (
    BOARD_MASK,
    CENTER_ORDER,
    HEIGHT,
    WIDTH,
    Board,
    IllegalMoveError,
    bit,
    four_mask,
    has_four,
)

DRAW_GAME = "547125662261271266215743771576315353334444"


def snapshot(board: Board):
    return (
        tuple(board.bitboards),
        tuple(board.heights),
        tuple(board.moves),
        board.hash,
        board.winner,
    )


def naive_has_four(cells: set[tuple[int, int]]) -> bool:
    for c, r in cells:
        for dc, dr in ((1, 0), (0, 1), (1, 1), (1, -1)):
            if all((c + i * dc, r + i * dr) in cells for i in range(4)):
                return True
    return False


def mask_of(cells) -> int:
    m = 0
    for c, r in cells:
        m |= bit(c, r)
    return m


# ----- win detection ---------------------------------------------------------


def test_horizontal_win_bottom_left():
    b = Board.from_moves([0, 0, 1, 1, 2, 2, 3])
    assert b.winner == 0
    assert b.winning_cells() == [(0, 0), (1, 0), (2, 0), (3, 0)]


def test_horizontal_win_against_right_border():
    b = Board.from_moves([3, 3, 4, 4, 5, 5, 6])
    assert b.winner == 0
    assert b.winning_cells() == [(3, 0), (4, 0), (5, 0), (6, 0)]


def test_vertical_win_for_second_player():
    b = Board.from_moves([0, 6, 1, 6, 0, 6, 1, 6])
    assert b.winner == 1
    assert b.winning_cells() == [(6, 0), (6, 1), (6, 2), (6, 3)]


def test_vertical_win_at_top_of_right_border_column():
    b = Board.from_moves([0, 6, 0, 6, 6, 1, 6, 1, 6, 2, 6])
    assert b.winner == 0
    assert b.winning_cells() == [(6, 2), (6, 3), (6, 4), (6, 5)]


def test_diagonal_up_right_win():
    b = Board.from_moves([0, 1, 1, 2, 3, 2, 2, 3, 6, 3, 3])
    assert b.winner == 0
    assert b.winning_cells() == [(0, 0), (1, 1), (2, 2), (3, 3)]


def test_diagonal_down_right_win():
    mirrored = [6 - c for c in [0, 1, 1, 2, 3, 2, 2, 3, 6, 3, 3]]
    b = Board.from_moves(mirrored)
    assert b.winner == 0
    assert b.winning_cells() == [(3, 3), (4, 2), (5, 1), (6, 0)]


def test_three_in_a_row_is_not_a_win():
    b = Board.from_moves([0, 0, 1, 1, 2])
    assert b.winner is None
    assert b.winning_cells() == []
    assert not b.is_over()


@pytest.mark.parametrize(
    "cells",
    [
        [(c, HEIGHT - 1) for c in range(3, 7)],          # top row, right edge
        [(0, r) for r in range(2, 6)],                   # left column, top
        [(3, 5), (4, 4), (5, 3), (6, 2)],                # down-right into corner
        [(0, 2), (1, 3), (2, 4), (3, 5)],                # up-right to top edge
    ],
)
def test_fours_touching_the_border_are_found(cells):
    assert has_four(mask_of(cells))
    assert four_mask(mask_of(cells)) == mask_of(cells)


@pytest.mark.parametrize(
    "cells",
    [
        [(0, 3), (0, 4), (0, 5), (1, 0)],   # vertical shift must not wrap columns
        [(5, 0), (6, 0), (0, 1), (1, 1)],   # horizontal "wrap" is not a line
        [(4, 3), (5, 4), (6, 5), (0, 0)],   # diagonal must not wrap
        [(6, 3), (6, 4), (6, 5), (0, 0)],
    ],
)
def test_no_false_wins_across_borders(cells):
    assert not has_four(mask_of(cells))


def test_has_four_matches_naive_scan_on_random_boards():
    rng = random.Random(9)
    all_cells = [(c, r) for c in range(WIDTH) for r in range(HEIGHT)]
    for _ in range(3000):
        cells = {cell for cell in all_cells if rng.random() < 0.35}
        assert has_four(mask_of(cells)) == naive_has_four(cells)


def test_draw_detection_on_a_full_board():
    b = Board.from_moves(DRAW_GAME)
    assert b.move_count == 42
    assert b.winner is None
    assert b.is_draw() and b.is_over()
    assert b.legal_moves() == []


def test_board_not_drawn_before_full():
    b = Board.from_moves(DRAW_GAME[:-1])
    assert not b.is_draw()
    assert b.legal_moves() == [3]


# ----- illegal moves -----------------------------------------------------------


@pytest.mark.parametrize("col", [-1, 7, 100])
def test_out_of_range_column_raises(col):
    with pytest.raises(IllegalMoveError, match="out of range"):
        Board().play(col)


@pytest.mark.parametrize("col", ["3", 2.0, None, True])
def test_non_int_column_raises(col):
    with pytest.raises(IllegalMoveError, match="must be an int"):
        Board().play(col)


def test_full_column_raises_and_leaves_board_untouched():
    b = Board.from_moves([2] * HEIGHT)
    before = snapshot(b)
    assert not b.can_play(2)
    assert 2 not in b.legal_moves()
    with pytest.raises(IllegalMoveError, match="column 2 is full"):
        b.play(2)
    assert snapshot(b) == before


def test_play_after_win_raises():
    b = Board.from_moves([0, 0, 1, 1, 2, 2, 3])
    with pytest.raises(IllegalMoveError, match="already over"):
        b.play(4)
    assert b.legal_moves() == []
    assert not b.is_winning_move(4)


def test_undo_on_empty_board_raises():
    with pytest.raises(IllegalMoveError, match="no move to undo"):
        Board().undo()


def test_illegal_move_error_is_a_value_error():
    assert issubclass(IllegalMoveError, ValueError)


# ----- make / undo and hashing ---------------------------------------------------


def test_make_undo_restores_exact_state_and_hash():
    rng = random.Random(5)
    for _ in range(200):
        b = Board()
        history = [snapshot(b)]
        while not b.is_over():
            b.play(rng.choice(b.legal_moves()))
            history.append(snapshot(b))
        history.pop()
        while b.moves:
            b.undo()
            assert snapshot(b) == history.pop()
        assert b.hash == 0 and b.bitboards == [0, 0]


def test_undo_returns_column_and_clears_winner():
    b = Board.from_moves([0, 0, 1, 1, 2, 2, 3])
    assert b.undo() == 3
    assert b.winner is None
    assert b.is_winning_move(3)
    assert not b.is_winning_move(5)


def test_transpositions_share_a_hash():
    a = Board.from_moves([3, 4, 2, 5])
    b = Board.from_moves([2, 5, 3, 4])
    assert a.hash == b.hash
    assert a.key() == b.key()


def test_different_positions_have_different_hashes():
    rng = random.Random(3)
    seen: dict[int, tuple[int, int]] = {}
    for _ in range(2000):
        b = Board()
        for _ in range(rng.randint(0, 20)):
            if b.is_over():
                break
            b.play(rng.choice(b.legal_moves()))
        if b.hash in seen:
            assert seen[b.hash] == b.key()
        seen[b.hash] = b.key()
    assert len(seen) > 1500


def test_hash_depends_on_who_owns_the_cell():
    assert Board.from_moves([3]).hash != Board.from_moves([0, 3]).hash


# ----- helpers -------------------------------------------------------------------


def test_from_string_is_one_based_and_ignores_spaces():
    assert Board.from_moves("44 53").moves == [3, 3, 4, 2]


def test_copy_is_independent():
    a = Board.from_moves("4453")
    b = a.copy()
    b.play(0)
    assert a.moves == [3, 3, 4, 2]
    assert b.moves == [3, 3, 4, 2, 0]
    assert a.hash != b.hash


def test_queries_and_rendering():
    b = Board.from_moves("44")
    assert b.current_player == 0
    assert b.cell(3, 0) == 0 and b.cell(3, 1) == 1 and b.cell(3, 2) is None
    assert b.column_height(3) == 2
    assert b.ordered_moves() == list(CENTER_ORDER)
    assert b.legal_moves() == list(range(WIDTH))
    text = str(b)
    assert text.splitlines()[-1] == "1 2 3 4 5 6 7"
    assert text.splitlines()[-2] == ". . . X . . ."
    assert text.splitlines()[-3] == ". . . O . . ."
    assert repr(b) == "Board.from_moves('44')"


def test_board_mask_covers_42_cells():
    assert bin(BOARD_MASK).count("1") == WIDTH * HEIGHT
