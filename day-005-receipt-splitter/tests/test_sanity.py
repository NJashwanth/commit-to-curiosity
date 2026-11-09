from decimal import Decimal

from models import Receipt
from sanity import check_receipt


def make(**over):
    data = {
        "merchant": "Diner",
        "items": [
            {"name": "Burger", "qty": 2, "unit_price": "8.50", "total": "17.00"},
            {"name": "Fries", "qty": 1, "unit_price": "3.00", "total": "3.00"},
        ],
        "subtotal": "20.00",
        "tax": "1.60",
        "total": "21.60",
    }
    data.update(over)
    return Receipt.model_validate(data)


def codes(r):
    return [i.code for i in check_receipt(r)]


def test_clean_receipt_has_no_issues():
    assert check_receipt(make()) == []


def test_clean_receipt_with_printed_tip():
    assert check_receipt(make(tip="4.00", total="25.60")) == []


def test_subtotal_mismatch_flagged():
    issues = check_receipt(make(subtotal="21.00", total="22.60"))
    assert [i.code for i in issues] == ["subtotal"]
    assert "20.00" in issues[0].message and "21.00" in issues[0].message


def test_total_mismatch_flagged():
    issues = check_receipt(make(total="25.00"))
    assert [i.code for i in issues] == ["total"]
    assert "21.60" in issues[0].message and "25.00" in issues[0].message


def test_total_mismatch_mentions_tip_only_when_printed():
    assert "tip" not in check_receipt(make(total="25.00"))[0].message
    assert "tip" in check_receipt(make(tip="1.00", total="25.00"))[0].message


def test_tip_missing_from_total_is_caught():
    # tip printed but the total does not include it
    assert codes(make(tip="4.00")) == ["total"]


def test_line_total_mismatch_flagged():
    items = [
        {"name": "Burger", "qty": 2, "unit_price": "8.50", "total": "18.00"},
        {"name": "Fries", "qty": 1, "unit_price": "3.00", "total": "3.00"},
    ]
    issues = check_receipt(make(items=items, subtotal="21.00", total="22.60"))
    assert [i.code for i in issues] == ["line_total"]
    assert "Burger" in issues[0].message


def test_multiple_problems_all_reported():
    assert codes(make(subtotal="19.00", total="99.00")) == ["subtotal", "total"]


def test_one_cent_tolerance():
    assert check_receipt(make(total="21.61")) == []
    assert codes(make(total="21.62")) == ["total"]


def test_custom_tolerance():
    assert check_receipt(make(total="21.65"), tolerance=Decimal("0.10")) == []


def test_negative_discount_line_sums():
    items = [
        {"name": "Pizza", "qty": 1, "unit_price": "12.00", "total": "12.00"},
        {"name": "Coupon", "qty": 1, "unit_price": "-2.00", "total": "-2.00"},
    ]
    assert check_receipt(make(items=items, subtotal="10.00", tax="0", total="10.00")) == []
