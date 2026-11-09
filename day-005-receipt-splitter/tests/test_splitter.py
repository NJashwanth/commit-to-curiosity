import random
from decimal import Decimal as D
from fractions import Fraction

import pytest

from models import Receipt
from splitter import SplitError, allocate, split_bill, to_cents


def make(items, tax="0", tip=None, total=None, subtotal=None):
    sub = sum(D(str(p)) for _, p in items)
    sub = D(subtotal) if subtotal is not None else sub
    tip_d = D(tip) if tip is not None else D(0)
    tot = D(total) if total is not None else sub + D(tax) + tip_d
    return Receipt.model_validate(
        {
            "merchant": "X",
            "items": [
                {"name": n, "qty": 1, "unit_price": str(p), "total": str(p)} for n, p in items
            ],
            "subtotal": str(sub),
            "tax": tax,
            "tip": tip,
            "total": str(tot),
        }
    )


def totals(result):
    return [s.total for s in result.shares]


# ---- rounding -------------------------------------------------------------


def test_100_dollars_three_ways():
    r = make([("Dinner", "100.00")])
    res = split_bill(r, ["A", "B", "C"])
    assert totals(res) == [D("33.34"), D("33.33"), D("33.33")]
    assert sum(totals(res)) == D("100.00")


def test_allocate_sums_exactly_and_orders_leftover():
    assert allocate(100, [Fraction(1)] * 3) == [34, 33, 33]
    assert allocate(1, [Fraction(1)] * 3) == [1, 0, 0]
    assert allocate(0, [Fraction(1)] * 3) == [0, 0, 0]


def test_allocate_largest_remainder_not_first_come():
    # exact quotas 3.33, 3.33, 3.33 + weighted: 10 cents over weights 1:1:1.0 vs uneven
    assert allocate(10, [Fraction(1), Fraction(1), Fraction(8)]) == [1, 1, 8]
    assert allocate(7, [Fraction(2), Fraction(3), Fraction(2)]) == [2, 3, 2]
    # remainders .4,.9,.7 -> leftover 2 goes to idx 1 and 2
    assert allocate(5, [Fraction(2), Fraction(3), Fraction(3)] ) == [1, 2, 2]


def test_allocate_zero_weights_falls_back_to_equal():
    assert allocate(10, [Fraction(0), Fraction(0)]) == [5, 5]


def test_allocate_negative_amount():
    out = allocate(-100, [Fraction(1)] * 3)
    assert sum(out) == -100


def test_allocate_needs_people():
    with pytest.raises(SplitError):
        allocate(10, [])


@pytest.mark.parametrize("n", [2, 3, 4, 5, 6, 7, 9, 11])
def test_even_split_always_sums_to_total(n):
    r = make([("A", "13.37"), ("B", "21.99"), ("C", "0.01")], tax="2.83", tip="5.01")
    res = split_bill(r, [f"P{i}" for i in range(n)])
    assert sum(totals(res)) == r.total
    # nobody is more than 3 cents from anyone else on an even split
    assert max(totals(res)) - min(totals(res)) <= D("0.03")


def test_random_receipts_always_add_up_exactly():
    rng = random.Random(5)
    for _ in range(300):
        items = [(f"i{k}", D(rng.randint(1, 5000)) / 100) for k in range(rng.randint(1, 8))]
        r = make(items, tax=str(D(rng.randint(0, 900)) / 100), tip=str(D(rng.randint(0, 900)) / 100))
        people = [f"P{i}" for i in range(rng.randint(1, 7))]
        assign = {i: rng.sample(people, rng.randint(1, len(people))) for i in range(len(items))}
        for a in (None, assign):
            res = split_bill(r, people, a, tip_percent=rng.choice([None, 15, 18.5, 20]))
            assert sum(totals(res)) == res.total
            for part in ("subtotal", "tax", "tip"):
                assert sum(getattr(s, part) for s in res.shares) == getattr(res, part)
            for s in res.shares:
                assert s.total == s.subtotal + s.tax + s.tip + s.adjustment


# ---- even / assigned / shared --------------------------------------------


def test_even_split_two_people():
    r = make([("A", "10.00"), ("B", "20.00")], tax="3.00")
    res = split_bill(r, ["Jash", "Ravi"])
    assert res.mode == "even"
    assert totals(res) == [D("16.50"), D("16.50")]
    assert res.shares[0].subtotal == D("15.00") and res.shares[0].tax == D("1.50")


def test_single_person_owes_everything():
    r = make([("A", "10.00")], tax="1.00")
    assert totals(split_bill(r, ["Solo"])) == [D("11.00")]


def test_item_assignment_with_proportional_tax():
    r = make([("Steak", "30.00"), ("Salad", "10.00")], tax="4.00")
    res = split_bill(r, ["A", "B"], assignments={0: ["A"], 1: ["B"]})
    a, b = res.shares
    assert (a.subtotal, b.subtotal) == (D("30.00"), D("10.00"))
    assert (a.tax, b.tax) == (D("3.00"), D("1.00"))  # 75% / 25%
    assert (a.total, b.total) == (D("33.00"), D("11.00"))
    assert res.mode == "assigned"


def test_shared_item_split_evenly_among_assignees():
    r = make([("Pizza", "20.00"), ("Beer", "6.00")])
    res = split_bill(r, ["A", "B", "C"], assignments={0: ["A", "B"], 1: ["C"]})
    assert [s.subtotal for s in res.shares] == [D("10.00"), D("10.00"), D("6.00")]


def test_shared_item_three_ways_rounds_exactly():
    r = make([("Nachos", "10.00")])
    res = split_bill(r, ["A", "B", "C"], assignments={0: ["A", "B", "C"]})
    assert totals(res) == [D("3.34"), D("3.33"), D("3.33")]


def test_proportional_tip_follows_subtotal_share():
    r = make([("Big", "75.00"), ("Small", "25.00")], tip="20.00")
    res = split_bill(r, ["A", "B"], assignments={0: ["A"], 1: ["B"]})
    assert [s.tip for s in res.shares] == [D("15.00"), D("5.00")]
    assert [s.total for s in res.shares] == [D("90.00"), D("30.00")]


def test_assignment_names_case_insensitive_and_duplicates_collapse():
    r = make([("Pizza", "20.00")])
    res = split_bill(r, ["Jash", "Ravi"], assignments={0: ["jash", "JASH"]})
    assert totals(res) == [D("20.00"), D("0.00")]


def test_person_with_nothing_owes_zero():
    r = make([("A", "10.00"), ("B", "5.00")], tax="1.50")
    res = split_bill(r, ["A", "B", "C"], assignments={0: ["A"], 1: ["B"]})
    assert res.shares[2].total == D("0.00")
    assert sum(totals(res)) == D("16.50")


def test_assignment_errors():
    r = make([("A", "10.00"), ("B", "5.00")])
    with pytest.raises(SplitError, match="not assigned"):
        split_bill(r, ["X", "Y"], assignments={0: ["X"]})
    with pytest.raises(SplitError, match="Unknown person 'Z'"):
        split_bill(r, ["X", "Y"], assignments={0: ["X"], 1: ["Z"]})


def test_people_errors():
    r = make([("A", "10.00")])
    with pytest.raises(SplitError, match="at least one"):
        split_bill(r, [" ", ""])
    with pytest.raises(SplitError, match="unique"):
        split_bill(r, ["Jash", "jash"])


# ---- tip override ---------------------------------------------------------


def test_tip_override_replaces_printed_tip():
    r = make([("A", "50.00")], tax="4.00", tip="5.00")  # total 59
    res = split_bill(r, ["A", "B"], tip_percent=20)
    assert res.tip == D("10.00")
    assert res.total == D("64.00")  # 50 + 4 + 10
    assert sum(totals(res)) == D("64.00")


def test_tip_override_when_no_printed_tip():
    r = make([("A", "33.33")], tax="2.67")
    res = split_bill(r, ["A", "B", "C"], tip_percent=18)
    assert res.tip == D("6.00")  # 5.9994 -> 6.00
    assert res.total == D("42.00")
    assert sum(totals(res)) == D("42.00")


def test_tip_override_zero_removes_tip():
    r = make([("A", "20.00")], tip="4.00")
    res = split_bill(r, ["A", "B"], tip_percent=0)
    assert res.tip == D("0.00") and res.total == D("20.00")


def test_tip_override_accepts_fractional_percent():
    r = make([("A", "100.00")])
    assert split_bill(r, ["A"], tip_percent=18.5).tip == D("18.50")


def test_tip_override_rounds_half_up():
    r = make([("A", "10.10")])  # 10.10 * 15% = 1.515
    assert split_bill(r, ["A"], tip_percent=15).tip == D("1.52")


def test_negative_tip_rejected():
    with pytest.raises(SplitError, match="negative"):
        split_bill(make([("A", "1.00")]), ["A"], tip_percent=-5)


def test_tip_override_proportional_in_assigned_mode():
    r = make([("Big", "60.00"), ("Small", "20.00")])
    res = split_bill(r, ["A", "B"], assignments={0: ["A"], 1: ["B"]}, tip_percent=20)
    assert [s.tip for s in res.shares] == [D("12.00"), D("4.00")]


# ---- inconsistent receipts ------------------------------------------------


def test_inconsistent_receipt_still_sums_to_printed_total():
    r = make([("A", "10.00"), ("B", "10.00")], total="25.00")  # should be 20.00
    res = split_bill(r, ["A", "B"])
    assert res.total == D("25.00")
    assert sum(totals(res)) == D("25.00")
    assert sum(s.adjustment for s in res.shares) == D("5.00")


def test_to_cents_rounds_half_up():
    assert to_cents(D("1.005")) == 101
    assert to_cents(D("1.004")) == 100
