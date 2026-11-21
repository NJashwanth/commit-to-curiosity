"""Replay rendering: animated GIF (Pillow) and a live terminal view (rich)."""
from __future__ import annotations

import time

from PIL import Image, ImageDraw, ImageFont

BG, GRID, FOOD, TEXT, DEAD = (17, 24, 39), (31, 41, 55), (239, 68, 68), (243, 244, 246), (251, 191, 36)
HEAD_COLOR, TAIL_COLOR = (134, 239, 172), (21, 94, 57)
HEADER = 28


def record_episode(agent, env, seed=None, max_frames=5000):
    """Play one greedy episode and return a list of snapshots, one per frame.

    The first frame is the starting board; every step adds a frame. A final
    snapshot marked ``dead`` is kept for the step that ended the episode.
    """
    obs = env.reset(seed=seed)
    frames = [dict(env.snapshot(), dead=False)]
    done = False
    while not done and len(frames) < max_frames:
        obs, _, done, info = env.step(agent.act(obs, greedy=True))
        frames.append(dict(env.snapshot(), dead=done and info["reason"] in ("wall", "self", "starved")))
    return frames


def _lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def segment_color(i, n):
    """Gradient from bright head (i=0) to dark tail (i=n-1)."""
    return _lerp(HEAD_COLOR, TAIL_COLOR, i / max(1, n - 1))


def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1 has a fixed-size default font
        return ImageFont.load_default()


def draw_frame(snap, cell=20, font=None):
    size = snap["size"]
    img = Image.new("RGB", (size * cell, size * cell + HEADER), BG)
    d = ImageDraw.Draw(img)
    d.text((8, HEADER // 2), f"score {snap['score']}", fill=TEXT, font=font or _font(14), anchor="lm")
    top = HEADER
    for i in range(size + 1):
        d.line([(i * cell, top), (i * cell, top + size * cell)], fill=GRID)
        d.line([(0, top + i * cell), (size * cell, top + i * cell)], fill=GRID)
    if snap["food"] is not None:
        fx, fy = snap["food"]
        pad = max(2, cell // 5)
        d.ellipse([fx * cell + pad, top + fy * cell + pad, (fx + 1) * cell - pad, top + (fy + 1) * cell - pad], fill=FOOD)
    snake = snap["snake"]
    for i, (x, y) in enumerate(snake):
        color = DEAD if (i == 0 and snap.get("dead")) else segment_color(i, len(snake))
        d.rounded_rectangle([x * cell + 1, top + y * cell + 1, (x + 1) * cell - 1, top + (y + 1) * cell - 1],
                            radius=max(2, cell // 4), fill=color)
    return img


def save_gif(snapshots, path, fps=12, cell=20, hold=1.0):
    """Write one GIF frame per snapshot; the last frame is held for ``hold`` seconds."""
    font = _font(14)
    frames = [draw_frame(s, cell, font) for s in snapshots]
    durations = [round(1000 / max(1, fps))] * len(frames)
    durations[-1] += round(hold * 1000)
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
    return path


def board_text(snap):
    """rich Text for one frame: gradient snake, red food, score line."""
    from rich.text import Text

    size, snake = snap["size"], snap["snake"]
    colors = {cell: "#%02x%02x%02x" % segment_color(i, len(snake)) for i, cell in enumerate(snake)}
    text = Text(f"score {snap['score']}\n", style="bold")
    for y in range(size):
        for x in range(size):
            if (x, y) in colors:
                head = (x, y) == snake[0]
                color = "#fbbf24" if head and snap.get("dead") else colors[(x, y)]
                text.append("██", style=color)
            elif (x, y) == snap["food"]:
                text.append("● ", style="#ef4444")
            else:
                text.append("· ", style="grey30")
        text.append("\n")
    return text


def watch_terminal(snapshots, fps=12, console=None):
    """Play recorded snapshots live in the terminal."""
    from rich.console import Console
    from rich.live import Live

    console = console or Console()
    with Live(board_text(snapshots[0]), console=console, refresh_per_second=max(1, fps), transient=False) as live:
        for snap in snapshots:
            live.update(board_text(snap), refresh=True)
            if fps > 0:
                time.sleep(1 / fps)
