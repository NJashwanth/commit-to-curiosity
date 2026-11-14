"""Textual front end: play Connect Four against one of the agents.

Keys: 1-7 or arrows + enter to drop, h hint, u undo, n new game, q quit.
The AI thinks in a worker thread so the board keeps animating.
"""

from __future__ import annotations

from typing import Callable

from rich.text import Text
from textual import events
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import Footer, Static

from .agents import Agent, SearchInfo, make_agent
from .engine import HEIGHT, PLAYER_NAMES, WIDTH, Board

# Every cell is drawn with background colours only (no block glyphs), so the
# board looks the same in a terminal and in an SVG screenshot.
#
#   gap line    . . . . . .      one line of board between rows
#   disc line   . X X X X .      the disc: 4 characters by 2 lines,
#   disc line   . X X X X .      which is about square on screen
#
CELL_W = 6  # characters per column: gap, 4 disc, gap
CELL_H = 3  # lines per row: gap line + 2 disc lines
DISC_W = 4
BORDER = 1  # board frame on each side

PIECE_COLOURS = ("#ef4444", "#facc15")
BOARD_BG = "#1d4ed8"
HOLE = "#0b1739"
WIN_FRAME = "#4ade80"
HINT = "#22d3ee"


# ----- the board widget ------------------------------------------------------------


class BoardView(Widget):
    """Draws the grid, the falling piece, the cursor and the winning four."""

    DEFAULT_CSS = """
    BoardView {
        width: auto;
        height: auto;
        padding: 0 1;
    }
    """

    def __init__(self, board: Board, **kwargs) -> None:
        super().__init__(**kwargs)
        self.board = board
        self.cursor = 3
        self.show_cursor = True
        self.cursor_colour = PIECE_COLOURS[0]
        self.hint: int | None = None
        # (col, landing row, current row, player) while a piece is dropping.
        self.falling: tuple[int, int, int, int] | None = None
        self.on_click_column: Callable[[int], None] | None = None

    def get_content_width(self, container, viewport) -> int:
        return WIDTH * CELL_W + 2 * BORDER

    def get_content_height(self, container, parent, width) -> int:
        # cursor line, 6 rows, bottom gap line, column numbers
        return 1 + HEIGHT * CELL_H + 1 + 1

    def column_at(self, x: int) -> int | None:
        """Which column a content x offset falls in, if any."""
        if x < BORDER:
            return None
        col = (x - BORDER) // CELL_W
        return col if col < WIDTH else None

    def on_click(self, event: events.Click) -> None:
        offset = event.get_content_offset(self)
        if offset is None or self.on_click_column is None:
            return
        col = self.column_at(offset.x)
        if col is not None:
            self.on_click_column(col)

    def _owner(self, col: int, row: int) -> int | None:
        if self.falling:
            f_col, f_land, f_row, f_player = self.falling
            if col == f_col and row == f_land:
                return f_player if f_row == f_land else None
            if col == f_col and row == f_row:
                return f_player
        return self.board.cell(col, row)

    def render(self) -> Text:
        text = Text(no_wrap=True)
        board = f"on {BOARD_BG}"
        frame = f"on {WIN_FRAME}"
        winners = set(self.board.winning_cells()) if not self.falling else set()

        def gap_line(below: int) -> None:
            """The board line above row ``below`` (or the bottom edge if -1).

            Its segment over a winning cell, or under one, turns green, which
            together with the side gaps draws a frame around each winning disc.
            """
            text.append(" " * BORDER, style=board)
            for c in range(WIDTH):
                lit = (c, below) in winners or (c, below + 1) in winners
                text.append(" " * CELL_W, style=frame if lit else board)
            text.append(" " * BORDER + "\n", style=board)

        # cursor line
        text.append(" " * BORDER)
        for c in range(WIDTH):
            if self.show_cursor and c == self.cursor:
                text.append("  ▼   ", style=f"bold {self.cursor_colour}")
            else:
                text.append(" " * CELL_W)
        text.append(" " * BORDER + "\n")
        for r in range(HEIGHT - 1, -1, -1):
            gap_line(r)
            for _ in range(CELL_H - 1):
                text.append(" " * BORDER, style=board)
                for c in range(WIDTH):
                    owner = self._owner(c, r)
                    side = frame if (c, r) in winners else board
                    disc = HOLE if owner is None else PIECE_COLOURS[owner]
                    text.append(" ", style=side)
                    text.append(" " * DISC_W, style=f"on {disc}")
                    text.append(" ", style=side)
                text.append(" " * BORDER + "\n", style=board)
        gap_line(-1)
        # column numbers; the hinted column is highlighted
        text.append(" " * BORDER)
        for c in range(WIDTH):
            label = f"  {c + 1}   "
            if c == self.hint:
                text.append(label, style=f"bold black on {HINT}")
            elif not self.board.can_play(c):
                text.append(label, style="dim")
            else:
                text.append(label, style="bold")
        return text


# ----- stats formatting (pure, so it is easy to test) ----------------------------------------


def _bars(values: dict[int, float]) -> Text:
    """A tiny column chart: one bar per board column."""
    blocks = " ▁▂▃▄▅▆▇█"
    top = max(values.values(), default=0) or 1
    text = Text()
    for c in range(WIDTH):
        v = values.get(c, 0)
        level = round(8 * v / top)
        text.append(f" {blocks[level] * 2} ", style="#a78bfa")
    text.append("\n")
    text.append("".join(f" {c + 1:^2} " for c in range(WIDTH)), style="dim")
    return text


def _plies(n: int) -> str:
    return f"{n} ply" if n == 1 else f"{n} plies"


def format_hint(info: SearchInfo) -> Text:
    """One compact block for the hint, so the panel never overflows."""
    text = Text()
    text.append("Hint for you\n", style="bold underline")
    text.append(f"column {info.move + 1}", style=f"bold {HINT}")
    text.append(f"  ·  {info.extra.get('label', '')}  ·  {info.elapsed:.2f} s", style="dim")
    return text


def format_stats(agent: Agent, info: SearchInfo | None, title: str = "Last AI move") -> Text:
    """The AI panel: what it played, how sure it is, and how hard it worked."""
    text = Text()
    text.append(f"{title}\n", style="bold underline")
    if info is None:
        text.append("Waiting for the first move.\n", style="dim")
        return text
    rows: list[tuple[str, str]] = [("Move", f"column {info.move + 1}")]
    extra = info.extra
    secs = max(info.elapsed, 1e-9)
    if "simulations" in extra:
        rows += [
            ("Win rate", extra["label"]),
            ("Simulations", f"{extra['simulations']:,}"),
            ("Tree size", f"{extra['tree_size']:,} nodes"),
            ("Best line", _plies(info.depth) + " deep"),
            ("Time", f"{info.elapsed:.2f} s"),
            ("Speed", f"{extra['simulations'] / secs / 1000:,.1f}k sims/s"),
        ]
    elif "tt_hits" in extra:
        rows += [
            ("Eval", extra["label"]),
            ("Depth", _plies(info.depth)),
            ("Nodes", f"{info.nodes:,}"),
            ("TT hits", f"{extra['tt_hits']:,}"),
            ("Time", f"{info.elapsed:.2f} s"),
            ("Speed", f"{info.nodes / secs / 1000:,.1f}k nodes/s"),
        ]
    else:
        rows += [("Time", f"{info.elapsed * 1000:.2f} ms"), ("Thinking", "none, it rolls dice")]
    for label, value in rows:
        text.append(f"{label:<12}", style="dim")
        text.append(f"{value}\n", style="bold")
    if "visits" in extra:
        text.append("Visits per column\n", style="dim")
        text.append_text(_bars(extra["visits"]))
    text.rstrip()
    return text


# ----- the app --------------------------------------------------------------------------------


class Connect4App(App):
    """Human vs AI Connect Four."""

    TITLE = "connect4-ai"
    ENABLE_COMMAND_PALETTE = False
    CSS = """
    Screen { align: center middle; }
    #main { width: auto; height: auto; }
    #left { width: auto; height: auto; }
    #status { width: 46; height: 2; padding: 0 1; }
    #side { width: 38; height: auto; padding: 0 0 0 2; }
    #who { height: auto; margin-bottom: 1; }
    #stats { height: auto; border: round #475569; padding: 0 1; }
    #help { height: auto; color: $text-muted; margin-top: 1; }
    """

    BINDINGS = [
        *[Binding(str(c + 1), f"drop({c})", show=False) for c in range(WIDTH)],
        Binding("left", "move_cursor(-1)", "Left", show=False),
        Binding("right", "move_cursor(1)", "Right", show=False),
        Binding("enter,space,down", "drop_cursor", "Drop", show=False),
        Binding("h", "hint", "Hint"),
        Binding("u", "undo", "Undo"),
        Binding("n", "new_game", "New game"),
        Binding("q", "quit", "Quit"),
    ]

    def __init__(
        self,
        ai: str = "minimax",
        level: str = "medium",
        human_first: bool = True,
        seed: int | None = None,
        drop_delay: float = 0.035,
        moves: str = "",
    ) -> None:
        super().__init__()
        self.ai_name = ai
        self.level = level
        self.human = 0 if human_first else 1
        self.agent = make_agent(ai, level, seed=seed)
        self.hint_agent = make_agent(ai, level, seed=seed)
        self.drop_delay = drop_delay
        self.start_moves = moves
        self.board = Board.from_moves(moves)
        self.thinking = False  # an AI search (move or hint) is running
        self.last_info: SearchInfo | None = None
        self.hint_info: SearchInfo | None = None
        self.message = ""
        self._drop_timer = None
        self._after_drop: Callable[[], None] | None = None

    # -- layout ------------------------------------------------------------

    def compose(self) -> ComposeResult:
        with Horizontal(id="main"):
            with Vertical(id="left"):
                self.view = BoardView(self.board, id="board")
                self.view.on_click_column = self.action_drop
                yield self.view
                yield Static(id="status")
            with Vertical(id="side"):
                yield Static(id="who")
                yield Static(id="stats")
                yield Static("drop: 1-7, ←/→ + enter, or click", id="help")
        yield Footer()

    def on_mount(self) -> None:
        self.refresh_panels()
        self._maybe_ai_turn()

    # -- state helpers ----------------------------------------------------------

    @property
    def animating(self) -> bool:
        return self.view.falling is not None

    @property
    def busy(self) -> bool:
        return self.thinking or self.animating

    @property
    def human_to_move(self) -> bool:
        return not self.board.is_over() and self.board.current_player == self.human

    def status_text(self) -> Text:
        b = self.board
        you = PIECE_COLOURS[self.human]
        ai = PIECE_COLOURS[self.human ^ 1]
        if b.winner is not None:
            if b.winner == self.human:
                line = Text("You win!  ", style=f"bold {you}")
            else:
                line = Text(f"{self.ai_name} wins.  ", style=f"bold {ai}")
            line.append("n new game · u undo", style="dim")
        elif b.is_draw():
            line = Text("Draw, the board is full.  ", style="bold")
            line.append("n new game", style="dim")
        elif self.thinking and not self.human_to_move:
            line = Text(f"{self.ai_name} is thinking...", style=f"bold {ai}")
        elif self.human_to_move:
            line = Text("Your move. ", style=f"bold {you}")
        else:
            line = Text("")
        if self.message:
            line.append(f"\n{self.message}")
        return line

    def refresh_panels(self) -> None:
        v = self.view
        v.show_cursor = self.human_to_move and not self.busy
        v.cursor_colour = PIECE_COLOURS[self.human]
        v.refresh()
        self.query_one("#status", Static).update(self.status_text())
        who = Text()
        who.append("Connect Four\n", style="bold")
        who.append("● you", style=f"bold {PIECE_COLOURS[self.human]}")
        who.append(f" ({PLAYER_NAMES[self.human]})  vs  ")
        who.append(f"● {self.ai_name}", style=f"bold {PIECE_COLOURS[self.human ^ 1]}")
        who.append(f"\n{self.agent.describe()} · {self.level}", style="dim")
        who.append(f"\nmove {self.board.move_count} of 42", style="dim")
        self.query_one("#who", Static).update(who)
        stats = format_stats(self.agent, self.last_info)
        if self.hint_info is not None:
            stats.append("\n\n")
            stats.append_text(format_hint(self.hint_info))
        self.query_one("#stats", Static).update(stats)

    # -- playing moves ---------------------------------------------------------------

    def _play(self, col: int, then: Callable[[], None]) -> None:
        """Play ``col`` on the board, then animate the drop, then call ``then``."""
        player = self.board.current_player
        land = self.board.column_height(col)
        self.board.play(col)
        self.view.hint = None
        self.hint_info = None
        self._after_drop = then
        if self.drop_delay <= 0:
            self.refresh_panels()
            then()
            return
        self.view.falling = (col, land, HEIGHT - 1, player)
        self.refresh_panels()
        self._drop_timer = self.set_interval(self.drop_delay, self._step_drop)

    def _step_drop(self) -> None:
        col, land, row, player = self.view.falling
        if row > land:
            self.view.falling = (col, land, row - 1, player)
            self.view.refresh()
            return
        self._drop_timer.stop()
        self._drop_timer = None
        self.view.falling = None
        then, self._after_drop = self._after_drop, None
        self.refresh_panels()
        then()

    def _after_move(self) -> None:
        self.refresh_panels()
        self._maybe_ai_turn()

    def _maybe_ai_turn(self) -> None:
        if self.board.is_over() or self.board.current_player == self.human:
            return
        self._start_search(self.agent, self._ai_done)

    def _start_search(self, agent: Agent, done: Callable[[SearchInfo], None]) -> None:
        self.thinking = True
        self.refresh_panels()
        snapshot = self.board.copy()

        def work() -> None:
            info = agent.analyse(snapshot)
            self.call_from_thread(done, info)

        self.run_worker(work, thread=True, group="ai", exit_on_error=True)

    def _ai_done(self, info: SearchInfo) -> None:
        self.thinking = False
        self.agent.last_info = info
        self.last_info = info
        self._play(info.move, self._after_move)

    def _hint_done(self, info: SearchInfo) -> None:
        self.thinking = False
        self.hint_info = info
        self.view.hint = info.move
        self.view.cursor = info.move
        self.message = f"Hint: column {info.move + 1} ({info.extra.get('label', '')})"
        self.refresh_panels()

    # -- actions ------------------------------------------------------------------------

    def _say(self, message: str) -> None:
        self.message = message
        self.refresh_panels()

    def action_drop(self, col: int) -> None:
        if self.busy:
            return
        if self.board.is_over():
            self._say("The game is over. Press n for a new game.")
            return
        if not self.human_to_move:
            return
        if not self.board.can_play(col):
            self._say(f"Column {col + 1} is full.")
            return
        self.message = ""
        self.view.cursor = col
        self._play(col, self._after_move)

    def action_move_cursor(self, step: int) -> None:
        self.view.cursor = (self.view.cursor + step) % WIDTH
        self.view.refresh()

    def action_drop_cursor(self) -> None:
        self.action_drop(self.view.cursor)

    def action_hint(self) -> None:
        if self.busy or not self.human_to_move:
            return
        self.message = "Looking for a good move..."
        self._start_search(self.hint_agent, self._hint_done)

    def action_undo(self) -> None:
        if self.busy:
            return
        if len(self.board.moves) <= self.human:
            self._say("Nothing to undo yet.")
            return
        # Take back the AI's reply (if any) and your last move.
        while self.board.moves:
            mover = (self.board.move_count - 1) & 1
            self.board.undo()
            if mover == self.human:
                break
        self.view.hint = None
        self.hint_info = None
        self._say("Took back your last move.")

    def action_new_game(self) -> None:
        if self.busy:
            return
        self.board = Board.from_moves(self.start_moves)
        self.view.board = self.board
        self.view.hint = None
        self.agent.reset()
        self.hint_agent.reset()
        self.last_info = None
        self.hint_info = None
        self.message = "New game."
        self.refresh_panels()
        self._maybe_ai_turn()
