import csv
import math

import pytest
import torch

import train as train_mod
from data import Dataset
from models import BigramLanguageModel, count_parameters
from train import CsvLogger, TrainConfig, build_model, estimate_loss, train

TEXT = "to be or not to be that is the question " * 40


@pytest.fixture
def ds():
    return Dataset.from_text(TEXT)


def test_bigram_shapes_and_initial_loss(ds):
    torch.manual_seed(0)
    V = ds.tokenizer.vocab_size
    model = BigramLanguageModel(V)
    x, y = ds.batch("train", 4, 8)
    logits, loss = model(x, y)
    assert logits.shape == (4, 8, V)
    # an untrained model is near uniform: loss ~ ln(V)
    assert abs(loss.item() - math.log(V)) < 1.0
    assert model(x)[1] is None
    assert model.config() == {"kind": "bigram", "vocab_size": V}
    assert count_parameters(model) == V * V


def test_estimate_loss_keys_and_mode(ds):
    model = BigramLanguageModel(ds.tokenizer.vocab_size)
    out = estimate_loss(model, ds, 4, 8, 3)
    assert set(out) == {"train", "val"}
    assert model.training  # restored after eval


def test_training_reduces_loss(ds):
    torch.manual_seed(0)
    model = BigramLanguageModel(ds.tokenizer.vocab_size)
    cfg = TrainConfig(steps=60, batch_size=16, block_size=8, lr=1e-2, eval_interval=30, eval_iters=5)
    result = train(model, ds, cfg, verbose=False)
    assert result["best_val"] < math.log(ds.tokenizer.vocab_size)
    assert result["tokens_per_sec"] > 0 and result["params"] > 0


def test_on_best_and_csv_log(ds, tmp_path, capsys):
    model = BigramLanguageModel(ds.tokenizer.vocab_size)
    cfg = TrainConfig(steps=20, batch_size=8, block_size=8, lr=1e-2, eval_interval=10, eval_iters=2)
    seen = []
    log = tmp_path / "runs" / "loss.csv"
    train(model, ds, cfg, log_path=log, model_name="bigram", on_best=lambda s, v: seen.append(s))
    assert seen and seen[0] == 0
    rows = list(csv.DictReader(log.open()))
    assert [int(r["step"]) for r in rows] == [0, 10, 20]
    assert rows[0]["model"] == "bigram"
    assert "parameters" in capsys.readouterr().out


def test_logger_keeps_other_models_and_replaces_own(tmp_path):
    path = tmp_path / "loss.csv"
    a = CsvLogger(path, "bigram")
    a.log(0, 4.0, 4.1, 100)
    b = CsvLogger(path, "gpt")
    b.log(0, 4.2, 4.3, 50)
    again = CsvLogger(path, "bigram")  # re-run bigram: old bigram rows replaced
    again.log(0, 3.0, 3.1, 100)
    rows = list(csv.DictReader(path.open()))
    assert sorted((r["model"], r["train_loss"]) for r in rows) == [("bigram", "3.0000"), ("gpt", "4.2000")]


def test_build_model():
    assert build_model("bigram", 5).vocab_size == 5
    with pytest.raises(ValueError):
        build_model("nope", 5)


def test_main_runs_offline(tmp_path, capsys):
    log = tmp_path / "loss.csv"
    train_mod.main(
        ["--model", "bigram", "--steps", "10", "--eval-interval", "5", "--eval-iters", "2",
         "--batch-size", "8", "--block-size", "8", "--offline", "--data-dir", str(tmp_path / "d"),
         "--log", str(log), "--ckpt-dir", str(tmp_path / "ck"), "--plot", str(tmp_path / "loss.png")]
    )
    assert "best val loss" in capsys.readouterr().out
    assert log.exists() and (tmp_path / "ck" / "bigram.pt").exists()
    assert (tmp_path / "ck" / "vocab.json").exists() and (tmp_path / "loss.png").stat().st_size > 1000


def test_main_no_plot(tmp_path):
    train_mod.main(
        ["--model", "gpt", "--steps", "4", "--eval-interval", "2", "--eval-iters", "1", "--batch-size", "4",
         "--block-size", "8", "--n-embd", "16", "--n-head", "2", "--n-layer", "1", "--offline",
         "--data-dir", str(tmp_path / "d"), "--log", str(tmp_path / "l.csv"), "--ckpt-dir", str(tmp_path / "ck"),
         "--no-plot"]
    )
    assert (tmp_path / "ck" / "gpt.pt").exists() and not (tmp_path / "loss.png").exists()
