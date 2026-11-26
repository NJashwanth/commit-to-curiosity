import pytest
import torch
from PIL import Image

import viz
from datasets import make_dataset
from schedule import make_schedule

PNG = b"\x89PNG"


def _is_png(path):
    return path.read_bytes()[:4] == PNG and path.stat().st_size > 1000


def test_forward_timesteps_are_quarters():
    steps = viz.forward_timesteps(100)
    assert [t for t, _ in steps] == [None, 24, 49, 74, 99]
    assert "100%" in steps[-1][1] and "data" in steps[0][1]


def test_forward_grid(tmp_path):
    out = viz.plot_forward_grid(make_dataset("moons", 200), make_schedule("cosine", 40), tmp_path / "a" / "f.png", "moons")
    assert _is_png(out)


def test_real_vs_generated(tmp_path):
    real = {n: (make_dataset(n, 100, 0), make_dataset(n, 100, 1)) for n in ("moons", "jn")}
    out = viz.plot_real_vs_generated(real, tmp_path / "rg.png", subtitle={"moons": "chamfer 0.1"})
    assert _is_png(out)


def test_loss_plot_with_short_series(tmp_path):
    out = viz.plot_loss({"a": [1.0, 0.5, 0.25], "b": [2.0] * 150}, tmp_path / "loss.png", window=100)
    assert _is_png(out)


def test_reverse_gif_frames_and_size(tmp_path):
    traj = [torch.randn(50, 2) * (1 - i / 11) for i in range(12)]
    out = viz.save_reverse_gif(traj, tmp_path / "g" / "r.gif", reference=make_dataset("moons", 50),
                               max_frames=6, size=2, dpi=40)
    with Image.open(out) as gif:
        assert gif.format == "GIF" and gif.n_frames == 6
        assert gif.size == (80, 80)
    assert out.stat().st_size < 3_000_000


def test_gif_uses_all_frames_when_short(tmp_path):
    traj = [torch.randn(10, 2) for _ in range(3)]
    out = viz.save_reverse_gif(traj, tmp_path / "s.gif", size=1.5, dpi=40)
    with Image.open(out) as gif:
        assert gif.n_frames == 3


def test_cli_forward_and_loss(tmp_path, capsys):
    viz.main(["forward", "--dataset", "moons", "--T", "20", "--n", "100", "--out", str(tmp_path / "f.png")])
    assert _is_png(tmp_path / "f.png")
    from train import write_log
    write_log(tmp_path / "moons_loss.csv", [1.0, 0.8, 0.6, 0.5])
    viz.main(["loss", "--datasets", "moons", "--log-dir", str(tmp_path), "--out", str(tmp_path / "l.png")])
    assert _is_png(tmp_path / "l.png")
    assert "l.png" in capsys.readouterr().out
