import copy

import pytest
import torch

from train import (Config, build_model, diffusion_loss, ema_update, load_checkpoint,
                   read_log, train)
from schedule import make_schedule

TINY = dict(dataset="moons", T=20, hidden=32, n_layers=3, time_dim=16, batch_size=128,
            n_data=1000, ema_decay=0.99)


def test_ema_update_math():
    model = torch.nn.Linear(2, 2)
    ema = copy.deepcopy(model)
    with torch.no_grad():
        for p in model.parameters():
            p.add_(1.0)
    before = [p.clone() for p in ema.parameters()]
    ema_update(ema, model, decay=0.9)
    for e, b, p in zip(ema.parameters(), before, model.parameters()):
        assert torch.allclose(e, 0.9 * b + 0.1 * p)
    ema_update(ema, model, decay=0.0)           # decay 0 copies the model
    assert all(torch.equal(e, p) for e, p in zip(ema.parameters(), model.parameters()))
    assert not any(p.requires_grad is False for p in model.parameters())


def test_ema_decay_one_freezes():
    model, ema = torch.nn.Linear(2, 2), torch.nn.Linear(2, 2)
    before = [p.clone() for p in ema.parameters()]
    ema_update(ema, model, decay=1.0)
    assert all(torch.equal(e, b) for e, b in zip(ema.parameters(), before))


def test_loss_is_scalar_and_finite():
    cfg = Config(**TINY)
    loss = diffusion_loss(build_model(cfg), make_schedule("cosine", 20), torch.randn(16, 2))
    assert loss.dim() == 0 and torch.isfinite(loss)


def test_short_training_reduces_loss(tmp_path):
    cfg = Config(steps=300, seed=1, **TINY)
    model, losses = train(cfg, ckpt_dir=tmp_path / "ck", log_dir=tmp_path / "logs")
    assert len(losses) == 300
    first, last = sum(losses[:30]) / 30, sum(losses[-30:]) / 30
    assert last < 0.85 * first
    assert not model.training

    # CSV log and checkpoint round-trip
    assert read_log(tmp_path / "logs" / "moons_loss.csv") == pytest.approx(losses)
    loaded, schedule, loaded_cfg = load_checkpoint(tmp_path / "ck" / "moons.pt")
    assert loaded_cfg == cfg and schedule.T == 20
    x, t = torch.randn(5, 2), torch.randint(0, 20, (5,))
    assert torch.allclose(loaded(x, t), model(x, t))


def test_training_is_seeded():
    cfg = Config(steps=20, seed=3, **TINY)
    assert train(cfg)[1] == train(cfg)[1]


def test_verbose_logging(capsys):
    train(Config(steps=2, **TINY), verbose=True)
    assert "step" in capsys.readouterr().out
