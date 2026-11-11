import math

import pytest
import torch

import generate as gen_mod
from checkpoint import load_checkpoint, save_checkpoint
from generate import generate_text, sample, validate_sampling
from models import GPT, BigramLanguageModel, GPTConfig
from tokenizer import CharTokenizer

TEXT = "to be or not to be that is the question\n"


@pytest.fixture
def tok():
    return CharTokenizer.from_text(TEXT)


@pytest.fixture
def model(tok):
    torch.manual_seed(0)
    return GPT(GPTConfig(tok.vocab_size, block_size=8, n_embd=16, n_head=2, n_layer=2, dropout=0.1))


def test_same_seed_same_text(model, tok):
    a = generate_text(model, tok, "to ", 40, 0.9, 5, seed=7)
    b = generate_text(model, tok, "to ", 40, 0.9, 5, seed=7)
    c = generate_text(model, tok, "to ", 40, 0.9, 5, seed=8)
    assert a == b and a != c
    assert a.startswith("to ") and len(a) == 3 + 40


def test_top_k_1_is_greedy(model, tok):
    ids = torch.tensor([tok.encode("to be")])
    greedy = sample(model, ids, 12, temperature=1.0, top_k=1, generator=torch.Generator().manual_seed(1))
    other = sample(model, ids, 12, temperature=1.0, top_k=1, generator=torch.Generator().manual_seed(2))
    assert torch.equal(greedy, other)  # the seed no longer matters
    # and it matches an explicit argmax loop (which also crops context to block_size)
    cur = ids
    model.eval()
    for _ in range(12):
        logits, _ = model(cur[:, -model.block_size :])
        cur = torch.cat([cur, logits[:, -1].argmax(-1, keepdim=True)], dim=1)
    assert torch.equal(greedy, cur)


def test_top_k_restricts_choices(model):
    ids = torch.zeros(1, 1, dtype=torch.long)
    logits, _ = model(ids)
    allowed = set(torch.topk(logits[0, -1], 3).indices.tolist())
    for seed in range(20):
        nxt = sample(model, ids, 1, top_k=3, generator=torch.Generator().manual_seed(seed))[0, -1].item()
        assert nxt in allowed


def test_top_k_larger_than_vocab_is_fine(model, tok):
    out = sample(model, torch.zeros(1, 1, dtype=torch.long), 3, top_k=10_000)
    assert out.shape == (1, 4)


def test_low_temperature_is_more_peaked(model):
    ids = torch.zeros(1, 1, dtype=torch.long)
    cold = torch.softmax(model(ids)[0][0, -1] / 0.1, -1).max()
    hot = torch.softmax(model(ids)[0][0, -1] / 5.0, -1).max()
    assert cold > hot


@pytest.mark.parametrize("temp", [0, -1.0, float("nan")])
def test_bad_temperature(model, tok, temp):
    with pytest.raises(ValueError, match="temperature"):
        validate_sampling(temp, None)
    with pytest.raises(ValueError, match="temperature"):
        generate_text(model, tok, "to", 3, temp)


def test_bad_top_k(model):
    with pytest.raises(ValueError, match="top_k"):
        sample(model, torch.zeros(1, 1, dtype=torch.long), 1, top_k=0)


def test_sample_restores_train_mode(model):
    model.train()
    sample(model, torch.zeros(1, 1, dtype=torch.long), 2)
    assert model.training


def test_empty_prompt_and_unknown_prompt_char(model, tok):
    out = generate_text(model, tok, "", 10, seed=0)
    assert len(out) == 10
    with pytest.raises(ValueError, match="not in vocab"):
        generate_text(model, tok, "Z!", 5)


def test_bigram_generates(tok):
    m = BigramLanguageModel(tok.vocab_size)
    assert len(generate_text(m, tok, "to", 20, seed=1)) == 22


def test_checkpoint_roundtrip_identical_outputs(model, tok, tmp_path):
    path = tmp_path / "ck" / "m.pt"
    save_checkpoint(path, model, tok, step=12, val_loss=1.5)
    loaded, tok2, meta = load_checkpoint(path)
    assert meta == {"step": 12, "val_loss": 1.5, "kind": "gpt"}
    assert tok2.chars == tok.chars and not loaded.training
    idx = torch.tensor([tok.encode("to be or")])
    model.eval()
    assert torch.equal(model(idx)[0], loaded(idx)[0])
    assert generate_text(model, tok, "to", 30, 0.8, 5, seed=3) == generate_text(loaded, tok2, "to", 30, 0.8, 5, seed=3)


def test_bigram_checkpoint_roundtrip(tok, tmp_path):
    m = BigramLanguageModel(tok.vocab_size)
    save_checkpoint(tmp_path / "b.pt", m, tok)
    loaded, _, meta = load_checkpoint(tmp_path / "b.pt")
    assert meta["kind"] == "bigram" and torch.equal(m.table.weight, loaded.table.weight)


def test_load_missing_checkpoint(tmp_path):
    with pytest.raises(FileNotFoundError, match="Train one first"):
        load_checkpoint(tmp_path / "nope.pt")


def test_load_unknown_kind(tok, tmp_path):
    torch.save({"config": {"kind": "rnn"}, "state_dict": {}, "vocab": ["a"], "step": 0, "val_loss": None}, tmp_path / "x.pt")
    with pytest.raises(ValueError, match="unknown model kind"):
        load_checkpoint(tmp_path / "x.pt")


def test_cli_prints_text(model, tok, tmp_path, capsys):
    path = tmp_path / "m.pt"
    save_checkpoint(path, model, tok)
    argv = ["--checkpoint", str(path), "--prompt", "to", "--tokens", "15", "--seed", "4"]
    gen_mod.main(argv)
    first = capsys.readouterr().out
    gen_mod.main(argv)
    assert capsys.readouterr().out == first and first.startswith("to")


def test_cli_friendly_errors(model, tok, tmp_path):
    with pytest.raises(SystemExit, match="Train one first"):
        gen_mod.main(["--checkpoint", str(tmp_path / "missing.pt")])
    path = tmp_path / "m.pt"
    save_checkpoint(path, model, tok)
    with pytest.raises(SystemExit, match="not in vocab"):
        gen_mod.main(["--checkpoint", str(path), "--prompt", "ZZZ"])
    with pytest.raises(SystemExit, match="temperature"):
        gen_mod.main(["--checkpoint", str(path), "--temperature", "0"])
