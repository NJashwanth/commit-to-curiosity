import json
from decimal import Decimal as D

import pytest
from PIL import Image

import extract
import split
from fakes import FakeClient
from models import Receipt

RECEIPT = {
    "merchant": "Chipotle",
    "date": "2026-11-09",
    "items": [
        {"name": "Burrito", "qty": 2, "unit_price": 10.0, "total": 20.0},
        {"name": "Chips", "qty": 1, "unit_price": 10.0, "total": 10.0},
    ],
    "subtotal": 30.0,
    "tax": 3.0,
    "tip": None,
    "total": 33.0,
}


@pytest.fixture
def img(tmp_path):
    p = tmp_path / "r.jpg"
    Image.new("RGB", (60, 60), "white").save(p)
    return str(p)


@pytest.fixture
def fake(monkeypatch):
    """Patch get_client so main() uses a scripted client."""

    def install(*replies):
        client = FakeClient(list(replies))
        monkeypatch.setattr(split, "get_client", lambda: client)
        return client

    return install


def run(capsys, argv, **kw):
    code = split.main(argv, **kw)
    cap = capsys.readouterr()
    return code, cap.out, cap.err


def test_default_even_split_table(capsys, fake, img):
    fake(json.dumps(RECEIPT))
    code, out, err = run(capsys, [img, "--people", "Jash,Ravi,Priya"])
    assert code == 0
    assert "Chipotle  (2026-11-09)" in out
    assert "Split: even" in out
    assert "11.00" in out and "TOTAL" in out and "33.00" in out
    assert 'Ravi: venmo Jash $11.00 "Chipotle 2026-11-09 split"' in out
    assert "Jash: paid the bill, own share $11.00" in out
    assert "WARNING" not in out


def test_json_output_is_clean_and_machine_readable(capsys, fake, img):
    fake(json.dumps(RECEIPT))
    code, out, err = run(capsys, [img, "--people", "A,B", "--json"])
    data = json.loads(out)
    assert code == 0
    assert data["total"] == 33.0 and data["mode"] == "even"
    assert [s["total"] for s in data["shares"]] == [16.5, 16.5]
    assert data["warnings"] == []
    assert data["payer"] == "A" and len(data["venmo"]) == 2
    assert data["tip_override_percent"] is None


def test_tip_override_flag(capsys, fake, img):
    fake(json.dumps(RECEIPT))
    code, out, _ = run(capsys, [img, "--people", "A,B", "--tip", "20", "--json"])
    data = json.loads(out)
    assert data["tip"] == 6.0 and data["total"] == 39.0
    assert sum(s["total"] for s in data["shares"]) == 39.0
    assert data["tip_override_percent"] == 20.0


def test_assign_mode_interactive(capsys, fake, img):
    fake(json.dumps(RECEIPT))
    answers = iter(["Jash", "all"])
    code, out, err = run(
        capsys, [img, "--people", "Jash,Ravi", "--assign", "--json"], input_fn=lambda _: next(answers)
    )
    data = json.loads(out)  # prompts went to stderr, stdout is pure JSON
    assert code == 0 and data["mode"] == "assigned"
    assert data["items"][0]["assigned_to"] == ["Jash"]
    assert data["items"][1]["assigned_to"] == ["Jash", "Ravi"]
    # Jash: 20 + 5 = 25 of 30 -> 25 + 2.50 tax = 27.50 ; Ravi 5 + 0.50
    assert [s["total"] for s in data["shares"]] == [27.5, 5.5]
    assert "Who had what?" in err


def test_assign_reprompts_on_bad_input(capsys, fake, img):
    fake(json.dumps(RECEIPT))
    answers = iter(["", "Nobody", "9", "1", "2"])
    code, out, err = run(
        capsys, [img, "--people", "Jash,Ravi", "--assign"], input_fn=lambda _: next(answers)
    )
    assert code == 0
    assert "Unknown person 'Nobody'" in err
    assert "No person numbered 9" in err
    assert "Enter at least one person" in err


def test_payer_flag(capsys, fake, img):
    fake(json.dumps(RECEIPT))
    code, out, _ = run(capsys, [img, "--people", "A,B", "--payer", "b"])
    assert 'A: venmo B $16.50' in out
    assert "B: paid the bill" in out


def test_payer_must_be_in_people(capsys, fake, img):
    code, _, err = run(capsys, [img, "--people", "A,B", "--payer", "Z"])
    assert code == 2 and "payer 'Z'" in err


def test_mismatch_is_flagged_not_hidden(capsys, fake, img):
    bad = json.dumps({**RECEIPT, "total": 40.0})
    fake(bad)
    code, out, _ = run(capsys, [img, "--people", "A,B"])
    assert code == 0
    assert "WARNING: this receipt does not add up" in out
    assert "total is 40.00" in out
    assert "Adjust" in out
    # shares still add up to the printed total
    fake(bad)
    code, out, _ = run(capsys, [img, "--people", "A,B", "--json"])
    data = json.loads(out)
    assert sum(s["total"] for s in data["shares"]) == 40.0
    assert data["warnings"][0]["code"] == "total"


def test_missing_api_key_message(capsys, monkeypatch, img):
    monkeypatch.setattr(extract, "load_dotenv", lambda: None)
    code, out, err = run(capsys, [img, "--people", "A,B"])
    assert code == 1 and out == ""
    assert "ANTHROPIC_API_KEY is not set" in err


def test_unsupported_image_message(capsys, fake, tmp_path):
    fake()
    bad = tmp_path / "r.gif"
    bad.write_bytes(b"GIF89a")
    code, _, err = run(capsys, [str(bad), "--people", "A,B"])
    assert code == 1 and "Unsupported image format" in err


def test_extraction_failure_message(capsys, fake, img):
    fake("nope", "still nope")
    code, _, err = run(capsys, [img, "--people", "A,B"])
    assert code == 1 and "after 2 attempts" in err


def test_api_error_message(capsys, monkeypatch, img):
    import anthropic

    class Boom:
        class messages:
            @staticmethod
            def create(**_):
                raise anthropic.APIError("connection refused", request=None, body=None)

    monkeypatch.setattr(split, "get_client", lambda: Boom)
    code, _, err = run(capsys, [img, "--people", "A,B"])
    assert code == 1 and "Anthropic API request failed" in err


def test_eof_during_assign_cancels(capsys, fake, img):
    fake(json.dumps(RECEIPT))

    def eof(_):
        raise EOFError

    code, _, err = run(capsys, [img, "--people", "A,B", "--assign"], input_fn=eof)
    assert code == 130 and "Cancelled" in err


def test_required_people_flag(capsys, img):
    with pytest.raises(SystemExit) as e:
        split.main([img])
    assert e.value.code == 2
    assert "--people" in capsys.readouterr().err


def test_empty_people_rejected(capsys, img):
    code, _, err = run(capsys, [img, "--people", " , "])
    assert code == 2 and "at least one name" in err


def test_negative_tip_rejected(capsys, img):
    code, _, err = run(capsys, [img, "--people", "A", "--tip=-5"])
    assert code == 2 and "negative" in err


def test_duplicate_people_error(capsys, fake, img):
    fake(json.dumps(RECEIPT))
    code, _, err = run(capsys, [img, "--people", "A,a"])
    assert code == 1 and "unique" in err


def test_parse_assignees():
    people = ["Jash", "Ravi", "Priya"]
    assert split.parse_assignees("1, ravi", people) == ["Jash", "Ravi"]
    assert split.parse_assignees("Ravi,2", people) == ["Ravi"]
    assert split.parse_assignees("ALL", people) == people
    with pytest.raises(split.SplitError):
        split.parse_assignees("0", people)


def test_table_widths_align():
    r = Receipt.model_validate(RECEIPT)
    res = split.split_bill(r, ["A very long name", "B"])
    lines = split.render_table(res, False).splitlines()
    assert len({len(l) for l in lines}) == 1


def test_main_module_guard(monkeypatch):
    import runpy

    monkeypatch.setattr("sys.argv", ["split.py"])
    with pytest.raises(SystemExit) as e:
        runpy.run_module("split", run_name="__main__")
    assert e.value.code == 2
