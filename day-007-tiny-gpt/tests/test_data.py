import urllib.error

import pytest
import torch

import data
from data import Dataset, get_batch, load_text, split_data


def test_split_is_90_10():
    train, val = split_data(torch.arange(1000))
    assert len(train) == 900 and len(val) == 100
    assert train[-1] + 1 == val[0]  # contiguous, no overlap


def test_split_rejects_bad_fraction():
    with pytest.raises(ValueError):
        split_data(torch.arange(10), 1.5)


@pytest.mark.parametrize("batch_size,block_size", [(1, 4), (4, 8), (16, 32)])
def test_batch_shapes_and_shift(batch_size, block_size):
    ids = torch.arange(500)  # id == position, so shift is easy to verify
    x, y = get_batch(ids, batch_size, block_size)
    assert x.shape == y.shape == (batch_size, block_size)
    assert x.dtype == torch.long
    assert torch.equal(y, x + 1)


def test_batch_targets_shifted_on_real_text():
    ds = Dataset.from_text("the quick brown fox jumps over the lazy dog " * 20)
    x, y = ds.batch("train", 8, 16)
    assert torch.equal(x[:, 1:], y[:, :-1])


def test_batch_seeded_generator_is_reproducible():
    ids = torch.arange(500)
    a = get_batch(ids, 4, 8, torch.Generator().manual_seed(1))
    b = get_batch(ids, 4, 8, torch.Generator().manual_seed(1))
    assert torch.equal(a[0], b[0])


def test_batch_needs_enough_data():
    with pytest.raises(ValueError):
        get_batch(torch.arange(5), 2, 8)


def test_dataset_from_text():
    ds = Dataset.from_text("abcdefghij" * 10, source="x")
    assert len(ds.train) == 90 and len(ds.val) == 10
    assert ds.tokenizer.vocab_size == 10 and ds.source == "x"


def test_load_text_downloads_and_caches(tmp_path, monkeypatch):
    monkeypatch.setattr(data, "download_text", lambda *a, **k: "z" * 2000)
    text, source = load_text(tmp_path)
    assert (text, source) == ("z" * 2000, "download")
    # second call hits the cache, not the network
    monkeypatch.setattr(data, "download_text", lambda *a, **k: pytest.fail("network used"))
    assert load_text(tmp_path)[1] == "cache"


def test_fallback_when_network_fails(tmp_path, monkeypatch, capsys):
    def boom(*a, **k):
        raise urllib.error.URLError("blocked")

    monkeypatch.setattr(data.urllib.request, "urlopen", boom)
    text, source = load_text(tmp_path)
    assert source == "fallback"
    assert "ROMEO:" in text and len(text) > 1000
    assert "using bundled fallback" in capsys.readouterr().err
    assert not (tmp_path / "input.txt").exists()  # fallback is not cached


def test_fallback_when_download_is_garbage(tmp_path, monkeypatch):
    monkeypatch.setattr(data, "download_text", lambda *a, **k: (_ for _ in ()).throw(ValueError("tiny")))
    assert load_text(tmp_path)[1] == "fallback"


def test_offline_flag_skips_network(tmp_path, monkeypatch):
    monkeypatch.setattr(data, "download_text", lambda *a, **k: pytest.fail("network used"))
    assert load_text(tmp_path, offline=True)[1] == "fallback"


def test_download_text_rejects_short_body(monkeypatch):
    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"Not Found"

    monkeypatch.setattr(data.urllib.request, "urlopen", lambda *a, **k: Resp())
    with pytest.raises(ValueError):
        data.download_text()


def test_download_text_ok(monkeypatch):
    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return ("a" * 1500).encode()

    monkeypatch.setattr(data.urllib.request, "urlopen", lambda *a, **k: Resp())
    assert len(data.download_text()) == 1500


def test_prepare_uses_bundled_fallback_offline(tmp_path):
    ds = Dataset.prepare(tmp_path, offline=True)
    assert ds.source == "fallback" and ds.tokenizer.vocab_size > 30
