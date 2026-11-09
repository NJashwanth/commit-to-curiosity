"""Command line entry point: python split.py receipt.jpg --people "A,B"."""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal
from typing import Callable, Sequence

import anthropic

from extract import (
    ExtractionError,
    MissingApiKeyError,
    extract_receipt,
    get_client,
)
from images import ImageError
from models import Receipt
from sanity import Issue, check_receipt
from splitter import SplitError, SplitResult, split_bill


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="split.py",
        description="Read a receipt image with Claude and split the bill.",
    )
    p.add_argument("image", help="receipt image (jpg, png, or heic)")
    p.add_argument("--people", required=True, help='comma separated names, e.g. "Jash,Ravi,Priya"')
    p.add_argument("--tip", type=float, metavar="PCT", help="tip as %% of subtotal (overrides any printed tip)")
    p.add_argument("--assign", action="store_true", help="interactively assign each item to people")
    p.add_argument("--json", action="store_true", help="print machine-readable JSON")
    p.add_argument("--payer", help="who paid the bill (default: first person)")
    p.add_argument("--model", help="override the Claude model (or set RECEIPT_MODEL)")
    return p


def parse_people(text: str) -> list[str]:
    return [n.strip() for n in text.split(",") if n.strip()]


# ---- interactive assignment ----------------------------------------------


def parse_assignees(text: str, people: Sequence[str]) -> list[str]:
    """Turn '1,Ravi' or 'all' into a list of names. Raises SplitError."""
    tokens = [t.strip() for t in text.split(",") if t.strip()]
    if not tokens:
        raise SplitError("Enter at least one person (or 'all').")
    chosen: list[str] = []
    lookup = {p.lower(): p for p in people}
    for tok in tokens:
        if tok.lower() == "all":
            return list(people)
        if tok.isdigit():
            idx = int(tok) - 1
            if not 0 <= idx < len(people):
                raise SplitError(f"No person numbered {tok}.")
            name = people[idx]
        elif tok.lower() in lookup:
            name = lookup[tok.lower()]
        else:
            raise SplitError(f"Unknown person '{tok}'.")
        if name not in chosen:
            chosen.append(name)
    return chosen


def prompt_assignments(
    receipt: Receipt,
    people: Sequence[str],
    input_fn: Callable[[str], str] = input,
    out=None,
) -> dict[int, list[str]]:
    """Ask who had each item. Prompts go to stderr so --json stays clean."""
    out = out or sys.stderr
    print("\nWho had what? Enter names or numbers separated by commas, or 'all'.", file=out)
    for n, p in enumerate(people, 1):
        print(f"  {n}. {p}", file=out)
    assignments: dict[int, list[str]] = {}
    for i, item in enumerate(receipt.items):
        label = f"{item.name} (x{item.qty:g}, ${item.total:.2f})"
        while True:
            answer = input_fn(f"\n{label}\n  shared by: ")
            try:
                assignments[i] = parse_assignees(answer, people)
                break
            except SplitError as exc:
                print(f"  {exc}", file=out)
    return assignments


# ---- output ---------------------------------------------------------------


def venmo_lines(result: SplitResult, merchant: str, date: str | None, payer: str) -> list[str]:
    note = f"{merchant} {date}" if date else merchant
    lines = []
    for s in result.shares:
        if s.name == payer:
            lines.append(f"{s.name}: paid the bill, own share ${s.total:.2f}")
        else:
            lines.append(f'{s.name}: venmo {payer} ${s.total:.2f} "{note} split"')
    return lines


def render_table(result: SplitResult, show_adjustment: bool) -> str:
    cols = ["Name", "Subtotal", "Tax", "Tip"] + (["Adjust"] if show_adjustment else []) + ["Total"]

    def row(name, s, t, tip, adj, total):
        return [name, f"{s:.2f}", f"{t:.2f}", f"{tip:.2f}"] + ([f"{adj:.2f}"] if show_adjustment else []) + [f"{total:.2f}"]

    rows = [row(s.name, s.subtotal, s.tax, s.tip, s.adjustment, s.total) for s in result.shares]
    adj_total = sum((s.adjustment for s in result.shares), Decimal(0))
    rows.append(row("TOTAL", result.subtotal, result.tax, result.tip, adj_total, result.total))
    widths = [max(len(r[c]) for r in [cols] + rows) for c in range(len(cols))]

    def fmt(r):
        cells = [r[0].ljust(widths[0])] + [r[c].rjust(widths[c]) for c in range(1, len(r))]
        return "  ".join(cells)

    sep = "  ".join("-" * w for w in widths)
    return "\n".join([fmt(cols), sep, *map(fmt, rows[:-1]), sep, fmt(rows[-1])])


def _num(x: Decimal) -> float:
    return float(x)


def result_to_dict(
    receipt: Receipt,
    result: SplitResult,
    issues: Sequence[Issue],
    payer: str,
    venmo: Sequence[str],
    tip_override: float | None,
    assignments: dict[int, list[str]] | None,
) -> dict:
    return {
        "merchant": receipt.merchant,
        "date": receipt.date,
        "mode": result.mode,
        "payer": payer,
        "tip_override_percent": tip_override,
        "items": [
            {
                "name": it.name,
                "qty": _num(it.qty),
                "unit_price": _num(it.unit_price),
                "total": _num(it.total),
                **({"assigned_to": assignments[i]} if assignments else {}),
            }
            for i, it in enumerate(receipt.items)
        ],
        "subtotal": _num(result.subtotal),
        "tax": _num(result.tax),
        "tip": _num(result.tip),
        "total": _num(result.total),
        "warnings": [{"code": i.code, "message": i.message} for i in issues],
        "shares": [
            {
                "name": s.name,
                "subtotal": _num(s.subtotal),
                "tax": _num(s.tax),
                "tip": _num(s.tip),
                "adjustment": _num(s.adjustment),
                "total": _num(s.total),
            }
            for s in result.shares
        ],
        "venmo": list(venmo),
    }


def render_text(receipt: Receipt, result: SplitResult, issues: Sequence[Issue], venmo: Sequence[str]) -> str:
    head = receipt.merchant + (f"  ({receipt.date})" if receipt.date else "")
    out = [head, f"Split: {result.mode}", ""]
    if issues:
        out.append("WARNING: this receipt does not add up. Check it against the photo.")
        out += [f"  ! {i.message}" for i in issues]
        out.append("")
    show_adj = any(s.adjustment != 0 for s in result.shares)
    out.append(render_table(result, show_adj))
    out += ["", *venmo]
    return "\n".join(out)


# ---- main -----------------------------------------------------------------


def main(argv: Sequence[str] | None = None, input_fn: Callable[[str], str] = input) -> int:
    args = build_parser().parse_args(argv)
    people = parse_people(args.people)
    if not people:
        print("Error: --people needs at least one name.", file=sys.stderr)
        return 2
    payer = args.payer or people[0]
    if payer.lower() not in {p.lower() for p in people}:
        print(f"Error: payer '{payer}' is not in --people.", file=sys.stderr)
        return 2
    payer = next(p for p in people if p.lower() == payer.lower())
    if args.tip is not None and args.tip < 0:
        print("Error: --tip cannot be negative.", file=sys.stderr)
        return 2

    try:
        client = get_client()
        receipt = extract_receipt(args.image, client=client, model=args.model)
        issues = check_receipt(receipt)
        assignments = None
        if args.assign:
            assignments = prompt_assignments(receipt, people, input_fn=input_fn)
        result = split_bill(receipt, people, assignments=assignments, tip_percent=args.tip)
    except (MissingApiKeyError, ImageError, ExtractionError, SplitError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except anthropic.APIError as exc:
        print(f"Error: Anthropic API request failed: {exc}", file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("\nCancelled.", file=sys.stderr)
        return 130

    venmo = venmo_lines(result, receipt.merchant, receipt.date, payer)
    if args.json:
        payload = result_to_dict(receipt, result, issues, payer, venmo, args.tip, assignments)
        print(json.dumps(payload, indent=2))
    else:
        print(render_text(receipt, result, issues, venmo))
    return 0


if __name__ == "__main__":
    sys.exit(main())
