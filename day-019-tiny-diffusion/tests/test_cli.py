from pathlib import Path

import pytest
from PIL import Image

import sample
import train

TINY = ["--dataset", "moons", "--steps", "30", "--T", "20", "--hidden", "16", "--n-layers", "2",
        "--batch-size", "32", "--n-data", "200"]


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    root = tmp_path_factory.mktemp("run")
    train.main(TINY + ["--ckpt-dir", str(root / "ck"), "--log-dir", str(root / "logs")])
    return root


def test_train_cli_writes_checkpoint_and_log(trained):
    assert (trained / "ck" / "moons.pt").exists()
    assert (trained / "logs" / "moons_loss.csv").exists()


def test_train_cli_flags():
    args = train.parse_args(["--no-learned-input", "--steps", "5"])
    assert args.no_learned_input and args.steps == 5
    assert args.ckpt_dir.name == "checkpoints"


def test_sample_cli_ddim_with_outputs(trained, capsys):
    gif, png = trained / "o.gif", trained / "o.png"
    sample.main(["--dataset", "moons", "--n", "100", "--sampler", "ddim", "--sampling-steps", "5",
                 "--ckpt", str(trained / "ck" / "moons.pt"), "--gif", str(gif), "--plot", str(png)])
    out = capsys.readouterr().out
    assert "DDIM (5 steps)" in out and "gaussian baseline" in out and "real vs real" in out
    assert png.exists()
    with Image.open(gif) as g:
        assert g.n_frames >= 2


def test_sample_cli_ddpm_and_compare(trained, capsys):
    ck = str(trained / "ck" / "moons.pt")
    sample.main(["--dataset", "moons", "--n", "50", "--sampler", "ddpm", "--ckpt", ck])
    assert "DDPM (20 steps)" in capsys.readouterr().out
    sample.main(["--dataset", "moons", "--n", "50", "--compare", "--sampling-steps", "50", "--ckpt", ck])
    out = capsys.readouterr().out
    assert "DDPM (20 steps)" in out and "DDIM (20 steps)" in out  # steps clamped to T


def test_ddpm_gif_path(trained):
    gif = trained / "d.gif"
    sample.main(["--dataset", "moons", "--n", "50", "--sampler", "ddpm", "--gif", str(gif),
                 "--ckpt", str(trained / "ck" / "moons.pt")])
    assert gif.exists()
