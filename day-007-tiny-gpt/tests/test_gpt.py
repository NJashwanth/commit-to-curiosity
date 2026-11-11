import math

import pytest
import torch

from data import Dataset
from models import GPT, Block, FeedForward, GPTConfig, Head, MultiHeadAttention, count_parameters
from train import TrainConfig, build_model, train

CONFIGS = [
    dict(n_embd=16, n_head=1, block_size=8),
    dict(n_embd=32, n_head=4, block_size=16),
    dict(n_embd=24, n_head=3, block_size=12),
]


@pytest.mark.parametrize("c", CONFIGS)
@pytest.mark.parametrize("B,T", [(1, 1), (2, 5), (3, 8)])
def test_attention_and_block_shapes(c, B, T):
    x = torch.randn(B, T, c["n_embd"])
    head_size = c["n_embd"] // c["n_head"]
    assert Head(c["n_embd"], head_size, c["block_size"], 0.0)(x).shape == (B, T, head_size)
    assert MultiHeadAttention(c["n_embd"], c["n_head"], c["block_size"], 0.0)(x).shape == x.shape
    assert FeedForward(c["n_embd"], 0.0)(x).shape == x.shape
    assert Block(c["n_embd"], c["n_head"], c["block_size"], 0.0)(x).shape == x.shape


def test_attention_rejects_indivisible_heads():
    with pytest.raises(ValueError):
        MultiHeadAttention(10, 3, 8, 0.0)
    with pytest.raises(ValueError):
        GPTConfig(vocab_size=5, n_embd=10, n_head=3)


def test_attention_weights_are_causal_and_normalized():
    torch.manual_seed(0)
    head = Head(16, 8, 6, 0.0)
    x = torch.randn(1, 6, 16)
    scores = head.query(x) @ head.key(x).transpose(-2, -1) * head.head_size**-0.5
    w = torch.softmax(scores.masked_fill(head.tril[:6, :6] == 0, float("-inf")), dim=-1)
    assert torch.allclose(w.sum(-1), torch.ones(1, 6))
    assert torch.all(torch.triu(w[0], diagonal=1) == 0)  # nothing above the diagonal


@pytest.mark.parametrize("c", CONFIGS)
def test_causal_mask_future_token_never_changes_earlier_outputs(c):
    torch.manual_seed(0)
    model = GPT(GPTConfig(vocab_size=11, n_layer=2, dropout=0.0, **c)).eval()
    T = c["block_size"]
    a = torch.randint(0, 11, (2, T))
    b = a.clone()
    cut = T // 2
    b[:, cut:] = (b[:, cut:] + 1) % 11  # change the future only
    la, _ = model(a)
    lb, _ = model(b)
    assert torch.allclose(la[:, :cut], lb[:, :cut], atol=1e-6)
    assert not torch.allclose(la[:, cut:], lb[:, cut:], atol=1e-6)  # and the change is visible later


@pytest.mark.parametrize("c", CONFIGS)
def test_gpt_forward_shapes_and_loss(c):
    V = 13
    model = GPT(GPTConfig(vocab_size=V, n_layer=2, **c))
    idx = torch.randint(0, V, (3, c["block_size"]))
    logits, loss = model(idx, idx)
    assert logits.shape == (3, c["block_size"], V)
    assert abs(loss.item() - math.log(V)) < 1.0  # near uniform at init
    assert model(idx[:, :3])[0].shape == (3, 3, V)  # shorter than block_size is fine
    assert model(idx)[1] is None


def test_too_long_sequence_rejected():
    model = GPT(GPTConfig(vocab_size=5, block_size=4, n_embd=8, n_head=2, n_layer=1))
    with pytest.raises(ValueError, match="block_size"):
        model(torch.zeros(1, 5, dtype=torch.long))


def test_default_config_is_about_one_million_params():
    model = GPT(GPTConfig(vocab_size=65))
    assert 0.8e6 < count_parameters(model) < 1.3e6


def test_dropout_only_active_in_train_mode():
    torch.manual_seed(0)
    model = GPT(GPTConfig(vocab_size=7, block_size=8, n_embd=16, n_head=2, n_layer=2, dropout=0.5))
    idx = torch.randint(0, 7, (2, 8))
    model.eval()
    assert torch.equal(model(idx)[0], model(idx)[0])
    model.train()
    assert not torch.equal(model(idx)[0], model(idx)[0])


def test_config_dict_roundtrip():
    model = GPT(GPTConfig(vocab_size=9, block_size=8, n_embd=16, n_head=2, n_layer=1))
    cfg = model.config()
    assert cfg["kind"] == "gpt"
    cfg.pop("kind")
    assert GPT(GPTConfig(**cfg)).cfg == model.cfg


def test_build_model_gpt():
    m = build_model("gpt", 10, block_size=8, n_embd=16, n_head=2, n_layer=1, dropout=0.0)
    assert isinstance(m, GPT) and m.block_size == 8


def test_loss_drops_on_tiny_repeated_string():
    torch.manual_seed(0)
    ds = Dataset.from_text("abcabcabc" * 60)
    model = GPT(GPTConfig(ds.tokenizer.vocab_size, block_size=8, n_embd=16, n_head=2, n_layer=2, dropout=0.0))
    cfg = TrainConfig(steps=60, batch_size=16, block_size=8, lr=1e-2, eval_interval=60, eval_iters=5)
    first = None

    def grab(step, val):
        nonlocal first
        first = first if first is not None else val

    result = train(model, ds, cfg, on_best=grab, verbose=False)
    assert first > 0.9  # starts near ln(3) ~ 1.1
    assert result["best_val"] < 0.3 * first  # a few dozen steps is enough to learn the pattern
