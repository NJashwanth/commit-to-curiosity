import io

import pytest
from PIL import Image
from rich.console import Console

import render
import watch
from agents import make_agent
from env import RIGHT, SnakeEnv


class AlwaysRight:
    epsilon = 0.0

    def act(self, obs, greedy=False):
        return RIGHT


def snap(**kw):
    base = {"size": 6, "snake": [(2, 2), (1, 2), (0, 2)], "food": (4, 4), "score": 3, "dead": False}
    base.update(kw)
    return base


def test_record_episode_frame_count():
    env = SnakeEnv(size=6, seed=0)
    frames = render.record_episode(AlwaysRight(), env, seed=0)
    assert len(frames) == 1 + env.steps  # start board + one frame per step
    assert frames[-1]["dead"] and not frames[0]["dead"]
    assert frames[-1]["score"] == env.score


def test_record_episode_respects_max_frames():
    env = SnakeEnv(size=6, seed=0)
    frames = render.record_episode(AlwaysRight(), env, seed=0, max_frames=2)
    assert len(frames) == 2


def test_draw_frame_geometry_and_colors():
    cell = 20
    img = render.draw_frame(snap(), cell=cell)
    assert img.size == (6 * cell, 6 * cell + render.HEADER)
    px = lambda x, y: img.getpixel((x * cell + cell // 2, render.HEADER + y * cell + cell // 2))
    assert px(4, 4) == render.FOOD
    assert px(2, 2) == render.HEAD_COLOR
    assert px(0, 2) == render.TAIL_COLOR
    assert px(5, 0) == render.BG


def test_snake_gradient_is_monotonic():
    colors = [render.segment_color(i, 8) for i in range(8)]
    assert colors[0] == render.HEAD_COLOR and colors[-1] == render.TAIL_COLOR
    greens = [c[1] for c in colors]
    assert greens == sorted(greens, reverse=True)
    assert render.segment_color(0, 1) == render.HEAD_COLOR


def test_dead_head_is_highlighted():
    cell = 20
    img = render.draw_frame(snap(dead=True), cell=cell)
    assert img.getpixel((2 * cell + 10, render.HEADER + 2 * cell + 10)) == render.DEAD


def test_score_overlay_changes_pixels():
    a = render.draw_frame(snap(score=0)).crop((0, 0, 120, render.HEADER))
    b = render.draw_frame(snap(score=12)).crop((0, 0, 120, render.HEADER))
    assert a.tobytes() != b.tobytes()


def test_gif_has_one_frame_per_snapshot(tmp_path):
    env = SnakeEnv(size=6, seed=2)
    frames = render.record_episode(AlwaysRight(), env, seed=2)
    path = render.save_gif(frames, tmp_path / "ep.gif", fps=20, cell=8)
    with Image.open(path) as gif:
        assert gif.n_frames == len(frames) > 2
        assert gif.size == (48, 48 + render.HEADER)
        gif.seek(gif.n_frames - 1)
        assert gif.info["duration"] > 1000  # last frame is held


def test_board_text_has_snake_food_and_score():
    plain = render.board_text(snap()).plain
    assert plain.splitlines()[0] == "score 3"
    assert plain.count("██") == 3 and plain.count("●") == 1
    assert render.board_text(snap(dead=True)).plain == plain


def test_watch_terminal_plays_every_frame():
    console = Console(file=io.StringIO(), force_terminal=True, width=60, height=30, record=True)
    frames = [snap(score=i) for i in range(3)]
    render.watch_terminal(frames, fps=0, console=console)
    out = console.export_text()
    assert "score 2" in out


def test_best_episode_picks_highest_score():
    env = SnakeEnv(size=6)
    agent = AlwaysRight()
    best = watch.best_episode(agent, env, seed=0, best_of=6)
    scores = [render.record_episode(agent, SnakeEnv(size=6), seed=i)[-1]["score"] for i in range(6)]
    assert best[-1]["score"] == max(scores)


def test_watch_cli_gif_and_terminal(tmp_path, capsys):
    gif = tmp_path / "docs" / "r.gif"
    code = watch.main(["--agent", "random", "--gif", str(gif), "--terminal", "--size", "6", "--fps", "0",
                       "--cell", "8", "--best-of", "2"])
    assert code == 0 and gif.exists()
    out = capsys.readouterr().out
    assert "random: score" in out and "frames" in out


def test_watch_cli_errors(tmp_path, capsys):
    with pytest.raises(SystemExit):
        watch.main(["--agent", "random"])
    assert watch.main(["--agent", "dqn", "--terminal", "--ckpt-dir", str(tmp_path)]) == 1
    assert "train.py --agent dqn" in capsys.readouterr().out


def test_agent_from_checkpoint_random():
    assert make_agent("random").name == watch.agent_from_checkpoint("random").name
