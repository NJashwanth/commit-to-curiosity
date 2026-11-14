"""Save the README screenshots with Textual's screenshot support.

    python tools/screenshots.py            # writes docs/tui-midgame.svg and docs/tui-win.svg

Both games are scripted and seeded, so the pictures are reproducible.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from connect4.tui import Connect4App  # noqa: E402

SIZE = (100, 25)


async def wait_idle(pilot, app) -> None:
    for _ in range(2000):
        await pilot.pause(0.01)
        if not app.busy:
            return
    raise TimeoutError("the app never went idle")


async def midgame(out: Path) -> str:
    """Against MCTS: a few moves in, AI stats showing, hint requested."""
    app = Connect4App(ai="mcts", level="medium", seed=7, drop_delay=0)
    async with app.run_test(size=SIZE) as pilot:
        await wait_idle(pilot, app)
        for key in ("4", "3", "5", "4"):
            await pilot.press(key)
            await wait_idle(pilot, app)
        await pilot.press("h")
        await wait_idle(pilot, app)
        return app.save_screenshot("tui-midgame.svg", str(out))


# Red's moves in a game where a depth 7 minimax played Red against the
# medium AI (depth 6). Red wins on move 35 with a diagonal.
WIN_GAME = "44444435515563551121117722222777733"
RED_MOVES = WIN_GAME[0::2]


async def win(out: Path) -> str:
    """Against minimax medium: Red finishes a diagonal and the four lights up."""
    app = Connect4App(ai="minimax", level="medium", drop_delay=0)
    async with app.run_test(size=SIZE) as pilot:
        await wait_idle(pilot, app)
        for key in RED_MOVES:
            await pilot.press(key)
            await wait_idle(pilot, app)
        moves = "".join(str(c + 1) for c in app.board.moves)
        assert moves == WIN_GAME, f"the AI played differently: {moves}"
        assert app.board.winner == 0
        return app.save_screenshot("tui-win.svg", str(out))


async def main() -> None:
    out = ROOT / "docs"
    out.mkdir(exist_ok=True)
    print(await midgame(out))
    print(await win(out))


if __name__ == "__main__":
    asyncio.run(main())
