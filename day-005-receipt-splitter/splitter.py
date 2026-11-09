"""Bill splitting with proportional tax/tip and exact cent rounding.

All arithmetic is done in integer cents. Shares of each component
(subtotal, tax, tip) are computed with the largest remainder method, so
every component, and therefore every total, adds up to the cent.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from typing import Mapping, Sequence

from models import Receipt


class SplitError(ValueError):
    """Invalid people, assignments, or tip."""


@dataclass(frozen=True)
class Share:
    name: str
    subtotal: Decimal
    tax: Decimal
    tip: Decimal
    adjustment: Decimal  # absorbs a receipt whose printed total does not add up
    total: Decimal


@dataclass(frozen=True)
class SplitResult:
    shares: list[Share]
    subtotal: Decimal
    tax: Decimal
    tip: Decimal
    total: Decimal
    mode: str  # "even" | "assigned"


def to_cents(amount: Decimal) -> int:
    return int((amount * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def from_cents(cents: int) -> Decimal:
    return Decimal(cents) / 100


def allocate(cents: int, weights: Sequence[Fraction]) -> list[int]:
    """Split `cents` in proportion to `weights`, summing exactly to `cents`.

    Largest remainder method: everyone gets the floor of their exact share,
    then the leftover cents go to those with the biggest fractional parts
    (ties go to the earlier person). Zero or negative total weight falls
    back to an equal split.
    """
    n = len(weights)
    if n == 0:
        raise SplitError("need at least one person")
    total_w = sum(weights, Fraction(0))
    if total_w <= 0:
        weights, total_w = [Fraction(1)] * n, Fraction(n)
    quotas = [Fraction(cents) * w / total_w for w in weights]
    floors = [math.floor(q) for q in quotas]
    leftover = cents - sum(floors)
    order = sorted(range(n), key=lambda i: (-(quotas[i] - floors[i]), i))
    for i in order[:leftover]:
        floors[i] += 1
    return floors


def _validate_people(people: Sequence[str]) -> list[str]:
    names = [p.strip() for p in people if p and p.strip()]
    if not names:
        raise SplitError("Give at least one person.")
    lowered = [n.lower() for n in names]
    if len(set(lowered)) != len(lowered):
        raise SplitError("Names must be unique (case-insensitive).")
    return names


def _weights(
    receipt: Receipt, names: list[str], assignments: Mapping[int, Sequence[str]] | None
) -> list[Fraction]:
    if assignments is None:
        return [Fraction(1)] * len(names)
    index = {n.lower(): i for i, n in enumerate(names)}
    weights = [Fraction(0)] * len(names)
    for i, item in enumerate(receipt.items):
        who = assignments.get(i)
        if not who:
            raise SplitError(f"Item '{item.name}' is not assigned to anyone.")
        owners = []
        for w in who:
            if w.lower() not in index:
                raise SplitError(f"Unknown person '{w}' on item '{item.name}'.")
            owners.append(index[w.lower()])
        owners = sorted(set(owners))
        part = Fraction(to_cents(item.total), len(owners))
        for o in owners:
            weights[o] += part
    return weights


def split_bill(
    receipt: Receipt,
    people: Sequence[str],
    assignments: Mapping[int, Sequence[str]] | None = None,
    tip_percent: Decimal | float | int | None = None,
) -> SplitResult:
    """Split a receipt among people.

    assignments: item index -> names sharing it (None means an even split).
    tip_percent: replaces any printed tip with this % of the subtotal, and
    the total is adjusted by the difference.
    """
    names = _validate_people(people)
    weights = _weights(receipt, names, assignments)

    subtotal_c = to_cents(receipt.subtotal)
    tax_c = to_cents(receipt.tax)
    printed_tip_c = to_cents(receipt.tip or Decimal(0))
    total_c = to_cents(receipt.total)

    if tip_percent is None:
        tip_c = printed_tip_c
    else:
        pct = Decimal(str(tip_percent))
        if pct < 0:
            raise SplitError("Tip percentage cannot be negative.")
        tip_c = to_cents(receipt.subtotal * pct / 100)
        total_c = total_c - printed_tip_c + tip_c

    adjustment_c = total_c - (subtotal_c + tax_c + tip_c)
    parts = [allocate(c, weights) for c in (subtotal_c, tax_c, tip_c, adjustment_c)]

    shares = [
        Share(
            name=name,
            subtotal=from_cents(parts[0][i]),
            tax=from_cents(parts[1][i]),
            tip=from_cents(parts[2][i]),
            adjustment=from_cents(parts[3][i]),
            total=from_cents(sum(p[i] for p in parts)),
        )
        for i, name in enumerate(names)
    ]
    return SplitResult(
        shares=shares,
        subtotal=from_cents(subtotal_c),
        tax=from_cents(tax_c),
        tip=from_cents(tip_c),
        total=from_cents(total_c),
        mode="even" if assignments is None else "assigned",
    )
