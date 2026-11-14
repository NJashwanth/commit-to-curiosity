import asyncio
import threading

import pytest

import play
from connect4.agents import Agent, RandomAgent, SearchInfo
from connect4.engine import Board
from connect4.mcts import MCTSAgent
from connect4.minimax import MinimaxAgent
from connect4.tui import (
    CELL_W,
    HINT,
    WIN_FRAME,
    BoardView,
    Connect4App,
    format_hint,
    format_stats,
)

DRAW_GAME = "547125662261271266215743771576315353334444"
SIZE = (100, 25)


async def idle(pilot, app):
    for _ in range(3000):
        await pilot.pause(0.005)
        if not app.busy:
            return
    raise TimeoutError("app stayed busy")


def run(app, script):
    async def go():
        async with app.run_test(size=SIZE) as pilot:
            await idle(pilot, app)
            await script(pilot, app)

    asyncio.run(go())


def easy_app(**kwargs):
    kwargs.setdefault("drop_delay", 0)
    return Connect4App(ai="minimax", level="easy", **kwargs)


# ----- playing ------------------------------------------------------------------------


def test_human_move_then_ai_reply_with_stats():
    app = easy_app()

    async def script(pilot, app):
        await pilot.press("4")
        await idle(pilot, app)
        assert app.board.moves[0] == 3
        assert app.board.move_count == 2
        assert app.last_info is not None and app.last_info.depth == 2
        stats = app.query_one("#stats").render()
        assert "Nodes" in str(stats) and "Eval" in str(stats)
        assert "Your move" in app.status_text().plain

    run(app, script)


def test_piece_animates_down_row_by_row():
    app = easy_app(drop_delay=0.005)
    frames = []  # (moves on board, falling row, landing cell owner) per step

    async def script(pilot, app):
        original = app._step_drop

        def record():
            col, land, row, player = app.view.falling
            frames.append((app.board.move_count, row, app.view._owner(col, land)))
            original()

        app._step_drop = record
        await pilot.press("1")
        await idle(pilot, app)

    run(app, script)
    human = [(row, owner) for n, row, owner in frames if n == 1]
    assert [row for row, _ in human] == [5, 4, 3, 2, 1, 0]
    # the landing cell looks empty until the piece gets there
    assert [owner for _, owner in human] == [None] * 5 + [0]
    # the AI's reply is animated too
    assert any(n == 2 for n, _, _ in frames)


def test_cursor_keys_and_enter():
    app = easy_app()

    async def script(pilot, app):
        await pilot.press("left", "left", "left", "left")  # 3 -> wraps to 6
        assert app.view.cursor == 6
        await pilot.press("right")
        assert app.view.cursor == 0
        await pilot.press("enter")
        await idle(pilot, app)
        assert app.board.moves[0] == 0

    run(app, script)


def test_click_drops_in_the_clicked_column():
    app = easy_app()

    async def script(pilot, app):
        # padding (1) + frame (1) + 4 columns of CELL_W + middle of the disc
        await pilot.click("#board", offset=(1 + 1 + 4 * CELL_W + 2, 10))
        await idle(pilot, app)
        assert app.board.moves[0] == 4

    run(app, script)


def test_full_column_is_refused_with_a_message():
    app = easy_app(moves="444444")

    async def script(pilot, app):
        await pilot.press("4")
        await idle(pilot, app)
        assert app.board.move_count == 6
        assert "Column 4 is full" in app.status_text().plain

    run(app, script)


class BlockingAgent(Agent):
    """Thinks until the test says it may answer."""

    name = "blocker"

    def __init__(self):
        super().__init__()
        self.release = threading.Event()

    def analyse(self, board):
        assert self.release.wait(5)
        return SearchInfo(move=0, extra={})


def test_keys_are_ignored_while_the_ai_thinks():
    app = easy_app()
    app.agent = BlockingAgent()

    async def script(pilot, app):
        await pilot.press("4")
        assert app.thinking and app.busy
        assert "thinking" in app.status_text().plain
        assert not app.view.show_cursor
        await pilot.press("1", "h", "u", "n", "enter")
        assert app.board.moves == [3]
        app.agent.release.set()
        await idle(pilot, app)
        assert app.board.moves == [3, 0]
        assert app.hint_info is None and app.message == ""

    run(app, script)


# ----- hint, undo, new game ----------------------------------------------------------------


def test_hint_shows_the_ai_suggestion():
    app = easy_app(moves="1122")

    async def script(pilot, app):
        await pilot.press("h")
        await idle(pilot, app)
        expected = MinimaxAgent(depth=2).analyse(app.board).move
        assert app.hint_info.move == expected == app.view.hint
        assert f"Hint: column {expected + 1}" in app.status_text().plain
        assert "Hint for you" in str(app.query_one("#stats").render())
        # the hinted column number is highlighted
        assert any(HINT in str(span.style) for span in app.view.render().spans)
        # playing a move clears the hint
        await pilot.press("4")
        await idle(pilot, app)
        assert app.view.hint is None and app.hint_info is None

    run(app, script)


def test_undo_takes_back_your_move_and_the_reply():
    app = easy_app()

    async def script(pilot, app):
        await pilot.press("u")
        assert "Nothing to undo" in app.status_text().plain
        await pilot.press("4")
        await idle(pilot, app)
        await pilot.press("3")
        await idle(pilot, app)
        assert app.board.move_count == 4
        await pilot.press("u")
        assert app.board.moves == [3, app.board.moves[1]] and app.board.move_count == 2
        assert "Took back" in app.status_text().plain
        await pilot.press("u")
        assert app.board.move_count == 0

    run(app, script)


def test_undo_after_losing_restores_play():
    # Red to move with three in column 7 (Yellow has three in column 1).
    app = easy_app(moves="717171")

    async def script(pilot, app):
        assert app.board.current_player == 0
        await pilot.press("7")  # Red wins: column 7 already holds three reds
        await idle(pilot, app)
        assert app.board.winner == 0
        assert "You win" in app.status_text().plain
        await pilot.press("3")
        assert "game is over" in app.status_text().plain
        await pilot.press("u")
        assert app.board.winner is None and app.board.move_count == 6

    run(app, script)


def test_ai_win_is_announced_and_highlighted():
    # Red ignores Yellow's three in column 1, the AI wins.
    app = easy_app(moves="716171")

    async def script(pilot, app):
        await pilot.press("5")
        await idle(pilot, app)
        assert app.board.winner == 1
        assert "minimax wins" in app.status_text().plain
        styles = [str(s.style) for s in app.view.render().spans]
        assert any(WIN_FRAME in st for st in styles)
        assert app.last_info.extra["label"] == "win in 1"
        await pilot.press("u")  # takes back the AI win and Red's move
        assert app.board.move_count == 6 and app.board.winner is None

    run(app, script)


def test_draw_is_announced():
    app = Connect4App(ai="random", human_first=False, drop_delay=0, moves=DRAW_GAME[:-1])

    async def script(pilot, app):
        await pilot.press("4")
        await idle(pilot, app)
        assert app.board.is_draw()
        assert "Draw" in app.status_text().plain

    run(app, script)


def test_new_game_resets_and_ai_can_start():
    app = Connect4App(ai="mcts", level="easy", human_first=False, seed=1, drop_delay=0)

    async def script(pilot, app):
        await idle(pilot, app)
        assert app.board.move_count == 1  # the AI opened
        assert "Simulations" in str(app.query_one("#stats").render())
        await pilot.press("1")
        await idle(pilot, app)
        assert app.board.move_count == 3
        await pilot.press("n")
        await idle(pilot, app)
        assert app.board.move_count == 1
        assert app.view.board is app.board
        await pilot.press("u")
        assert "Nothing to undo" in app.status_text().plain

    run(app, script)


# ----- pure helpers -------------------------------------------------------------------------


def test_column_at_maps_x_offsets():
    view = BoardView(Board())
    assert view.column_at(0) is None
    assert view.column_at(1) == 0
    assert view.column_at(1 + CELL_W) == 1
    assert view.column_at(1 + 7 * CELL_W - 1) == 6
    assert view.column_at(1 + 7 * CELL_W) is None


def test_board_render_has_cursor_rows_and_numbers():
    view = BoardView(Board.from_moves("4"))
    lines = view.render().plain.split("\n")
    assert len(lines) == 1 + 6 * 3 + 1 + 1
    assert "▼" in lines[0]
    assert lines[-1].split() == [str(c) for c in range(1, 8)]
    view.show_cursor = False
    assert "▼" not in view.render().plain


def test_format_stats_for_each_agent():
    assert "Waiting" in format_stats(RandomAgent(), None).plain
    board = Board.from_moves("4453")
    mm = MinimaxAgent(depth=3)
    text = format_stats(mm, mm.analyse(board)).plain
    assert "Depth" in text and "3 plies" in text and "TT hits" in text
    one = SearchInfo(move=0, depth=1, nodes=1, elapsed=0.0, extra={"tt_hits": 0, "label": "+1"})
    assert "1 ply" in format_stats(mm, one).plain
    mc = MCTSAgent(iterations=200, seed=0)
    text = format_stats(mc, mc.analyse(board)).plain
    assert "Simulations" in text and "Visits per column" in text
    rnd = RandomAgent(seed=0)
    assert "rolls dice" in format_stats(rnd, rnd.analyse(board)).plain
    hint = format_hint(SearchInfo(move=2, elapsed=0.5, extra={"label": "+4"})).plain
    assert "column 3" in hint and "+4" in hint


def test_play_cli_builds_the_app():
    app = play.make_app(["--ai", "mcts", "--level", "hard", "--ai-first", "--seed", "3"])
    assert isinstance(app, Connect4App)
    assert app.ai_name == "mcts" and app.level == "hard" and app.human == 1
    assert app.agent.time_limit == 3.0 and app.agent.seed == 3
    default = play.make_app([])
    assert default.ai_name == "minimax" and default.level == "medium" and default.human == 0


def test_play_cli_rejects_unknown_ai():
    with pytest.raises(SystemExit):
        play.make_app(["--ai", "deepblue"])
