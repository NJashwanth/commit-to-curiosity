import json
from decimal import Decimal

import pytest

from models import Receipt, ReceiptParseError, parse_receipt_json

GOOD = {
    "merchant": "Taco Place",
    "date": "2026-11-09",
    "items": [
        {"name": "Tacos", "qty": 2, "unit_price": 4.5, "total": 9.0},
        {"name": "Soda", "qty": 1, "unit_price": 2.0, "total": 2.0},
    ],
    "subtotal": 11.0,
    "tax": 0.88,
    "tip": None,
    "total": 11.88,
}


def test_accepts_good_json():
    r = parse_receipt_json(json.dumps(GOOD))
    assert isinstance(r, Receipt)
    assert r.merchant == "Taco Place"
    assert r.items[0].unit_price == Decimal("4.5")
    assert r.tip is None
    assert r.total == Decimal("11.88")


def test_optional_fields_default():
    data = {k: v for k, v in GOOD.items() if k not in ("date", "tip", "tax")}
    r = parse_receipt_json(json.dumps(data))
    assert r.date is None and r.tip is None and r.tax == 0


def test_item_qty_defaults_to_one():
    data = json.loads(json.dumps(GOOD))
    del data["items"][1]["qty"]
    assert parse_receipt_json(json.dumps(data)).items[1].qty == 1


def test_strips_code_fences_and_prose():
    raw = "Here you go:\n```json\n" + json.dumps(GOOD) + "\n```\nHope that helps"
    assert parse_receipt_json(raw).merchant == "Taco Place"


def test_blank_date_becomes_none():
    assert parse_receipt_json(json.dumps({**GOOD, "date": "  "})).date is None


@pytest.mark.parametrize("missing", ["merchant", "items", "subtotal", "total"])
def test_rejects_missing_required_field(missing):
    data = {k: v for k, v in GOOD.items() if k != missing}
    with pytest.raises(ReceiptParseError, match=missing):
        parse_receipt_json(json.dumps(data))


def test_rejects_empty_items():
    with pytest.raises(ReceiptParseError, match="items"):
        parse_receipt_json(json.dumps({**GOOD, "items": []}))


def test_rejects_bad_types():
    data = {**GOOD, "subtotal": "lots"}
    with pytest.raises(ReceiptParseError, match="subtotal"):
        parse_receipt_json(json.dumps(data))


def test_rejects_bad_item():
    data = json.loads(json.dumps(GOOD))
    data["items"][0]["qty"] = 0
    with pytest.raises(ReceiptParseError, match=r"items\.0\.qty"):
        parse_receipt_json(json.dumps(data))


def test_rejects_blank_item_name():
    data = json.loads(json.dumps(GOOD))
    data["items"][0]["name"] = "   "
    with pytest.raises(ReceiptParseError, match="blank"):
        parse_receipt_json(json.dumps(data))


def test_rejects_bad_date():
    with pytest.raises(ReceiptParseError, match="date"):
        parse_receipt_json(json.dumps({**GOOD, "date": "11/09/26"}))


@pytest.mark.parametrize(
    "raw, msg",
    [
        ("no json here", "no JSON object"),
        ('{"merchant": "x",', "no JSON object"),
        ("{merchant: 'x'}", "invalid JSON"),
        ("", "no JSON object"),
    ],
)
def test_rejects_malformed(raw, msg):
    with pytest.raises(ReceiptParseError, match=msg):
        parse_receipt_json(raw)


def test_rejects_non_object_top_level():
    with pytest.raises(ReceiptParseError, match="no JSON object"):
        parse_receipt_json("[1, 2]")
