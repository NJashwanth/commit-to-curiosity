"""Arithmetic sanity checks on an extracted receipt.

Mismatches are returned as issues, never silently corrected, so the caller
can show them to the user.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from models import Receipt

TOLERANCE = Decimal("0.01")  # one cent of slack for per-line rounding


@dataclass(frozen=True)
class Issue:
    code: str  # line_total | subtotal | total
    message: str


def _money(x: Decimal) -> str:
    return f"{x:.2f}"


def check_receipt(receipt: Receipt, tolerance: Decimal = TOLERANCE) -> list[Issue]:
    """Return a list of problems; an empty list means the receipt adds up."""
    issues: list[Issue] = []

    for item in receipt.items:
        expected = item.qty * item.unit_price
        if abs(expected - item.total) > tolerance:
            issues.append(
                Issue(
                    "line_total",
                    f"Item '{item.name}': {item.qty} x {_money(item.unit_price)} "
                    f"= {_money(expected)}, but line total is {_money(item.total)}",
                )
            )

    items_sum = sum((i.total for i in receipt.items), Decimal(0))
    if abs(items_sum - receipt.subtotal) > tolerance:
        issues.append(
            Issue(
                "subtotal",
                f"Items sum to {_money(items_sum)}, but subtotal is "
                f"{_money(receipt.subtotal)} (off by {_money(receipt.subtotal - items_sum)})",
            )
        )

    tip = receipt.tip or Decimal(0)
    expected_total = receipt.subtotal + receipt.tax + tip
    if abs(expected_total - receipt.total) > tolerance:
        parts = f"subtotal {_money(receipt.subtotal)} + tax {_money(receipt.tax)}"
        if receipt.tip is not None:
            parts += f" + tip {_money(tip)}"
        issues.append(
            Issue(
                "total",
                f"{parts} = {_money(expected_total)}, but total is "
                f"{_money(receipt.total)} (off by {_money(receipt.total - expected_total)})",
            )
        )
    return issues
