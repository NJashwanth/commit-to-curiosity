import json
from decimal import Decimal as D

import pytest
from PIL import Image

import extract
from evals import generate, run
from fakes import FakeClient
from models import Receipt
from sanity import check_receipt


@pytest.fixture(scope="module")
def receipts(tmp_path_factory):
    d = tmp_path_factory.mktemp("receipts")
    generate.generate(d, 10)
    return d


def test_generates_ten_images_with_ground_truth(receipts):
    pngs = sorted(receipts.glob("*.png"))
    assert len(pngs) == 10
    for p in pngs:
        assert p.with_suffix(".json").exists()
        with Image.open(p) as im:
            assert im.width > 300 and im.height > 300


def test_ground_truth_is_valid_and_self_consistent(receipts):
    tips = 0
    for j in receipts.glob("*.json"):
        r = Receipt.model_validate(json.loads(j.read_text()))
        assert check_receipt(r) == [], j.name
        tips += r.tip is not None
    assert tips == 2


def test_receipts_vary(receipts):
    merchants = {json.loads(j.read_text())["merchant"] for j in receipts.glob("*.json")}
    sizes = {Image.open(p).size for p in receipts.glob("*.png")}
    assert len(merchants) == 10 and len(sizes) > 5


def test_generation_is_deterministic():
    assert generate.make_truth(3) == generate.make_truth(3)
    assert generate.make_truth(3) != generate.make_truth(4)


def test_font_fallback_to_default(monkeypatch):
    monkeypatch.setattr(generate, "FONT_DIRS", [])
    img = generate.render(generate.make_truth(0), 0)
    assert img.size[0] > 100


def test_generate_main(tmp_path, capsys):
    assert generate.main(["--out", str(tmp_path / "o"), "--count", "2"]) == 0
    assert len(list((tmp_path / "o").glob("*.png"))) == 2
    assert "Wrote 2 receipts" in capsys.readouterr().out


def _r(items, total, subtotal=None):
    sub = subtotal if subtotal is not None else sum(i[2] for i in items)
    return Receipt.model_validate(
        {
            "merchant": "M",
            "items": [{"name": n, "qty": q, "unit_price": t / q, "total": t} for n, q, t in items],
            "subtotal": sub,
            "tax": 0,
            "total": total,
        }
    )


def test_score_perfect():
    t = _r([("Pizza", 1, 10.0), ("Beer", 2, 8.0)], 18.0)
    s = run.score_receipt("x", t, t)
    assert (s.items_correct, s.items_total, s.items_extra) == (2, 2, 0)
    assert s.total_ok and s.sanity_ok


def test_score_fuzzy_name_but_wrong_total_and_extra_item():
    truth = _r([("Margherita Pizza", 1, 10.0), ("Beer", 1, 5.0)], 15.0)
    pred = _r([("Margarita Pizza", 1, 10.0), ("Beer", 1, 6.0), ("Ghost", 1, 1.0)], 18.0, subtotal=17.0)
    s = run.score_receipt("x", pred, truth)
    assert s.items_correct == 1  # pizza matches fuzzily, beer has the wrong price
    assert s.items_extra == 2
    assert not s.total_ok and not s.sanity_ok


def test_score_item_claimed_once():
    truth = _r([("Coffee", 1, 3.0), ("Coffee", 1, 3.0)], 6.0)
    pred = _r([("Coffee", 1, 3.0)], 3.0)
    assert run.score_receipt("x", pred, truth).items_correct == 1


def test_summarize_and_markdown():
    t = _r([("A", 1, 1.0)], 1.0)
    good = run.score_receipt("receipt_01", t, t)
    bad = run.Score("receipt_02", 3, 0, 0, False, False, error="boom")
    summary = run.summarize([good, bad])
    assert summary["item_accuracy"] == 0.25
    assert summary["total_accuracy"] == 0.5
    assert summary["failed"] == 1
    md = run.render_markdown([good, bad], summary, "m-1")
    assert "| Item-level accuracy | 25.0% (1/4 items) |" in md
    assert "boom" in md and "`m-1`" in md


def test_summarize_empty():
    assert run.summarize([])["item_accuracy"] == 0.0


def test_run_main_with_scripted_client(receipts, tmp_path, monkeypatch, capsys):
    replies = [j.read_text() for j in sorted(receipts.glob("*.json"))]
    replies[2] = "garbage"  # one receipt fails both attempts
    script = []
    for i, r in enumerate(replies):
        script += ["garbage", "garbage"] if i == 2 else [r]
    client = FakeClient(script)
    monkeypatch.setattr(run, "get_client", lambda: client)
    out = tmp_path / "results.md"
    assert run.main(["--dir", str(receipts), "--out", str(out), "--model", "m"]) == 0
    md = out.read_text()
    assert "Extraction failures | 1" in md
    assert "Total accuracy | 90.0%" in md


def test_run_main_generates_missing_receipts(tmp_path, monkeypatch):
    d = tmp_path / "fresh"
    monkeypatch.setattr(run, "get_client", lambda: FakeClient([]))
    monkeypatch.setattr(run, "run", lambda *a, **k: [])
    assert run.main(["--dir", str(d), "--out", str(tmp_path / "r.md")]) == 0
    assert len(list(d.glob("*.png"))) == 10


def test_run_main_missing_key(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(extract, "load_dotenv", lambda: None)
    assert run.main(["--dir", str(tmp_path), "--out", str(tmp_path / "r.md")]) == 1
    assert "ANTHROPIC_API_KEY is not set" in capsys.readouterr().err
