"""Run extraction on the synthetic receipts and report accuracy.

    python evals/run.py [--dir evals/receipts] [--out evals/results.md]

Needs ANTHROPIC_API_KEY (this makes real API calls, one per receipt).
Generates the receipts first if the directory is empty.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import sys
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from evals.generate import generate  # noqa: E402
from extract import DEFAULT_MODEL, ExtractionError, MissingApiKeyError, extract_receipt, get_client  # noqa: E402
from models import Receipt  # noqa: E402
from sanity import check_receipt  # noqa: E402

CENT = Decimal("0.005")
NAME_MATCH = 0.8  # fuzzy name similarity needed to count an item as the same


@dataclass
class Score:
    name: str
    items_total: int  # ground truth items
    items_correct: int
    items_extra: int  # predicted items matching nothing
    total_ok: bool
    sanity_ok: bool
    error: str | None = None


def _close(a: Decimal, b: Decimal) -> bool:
    return abs(a - b) <= CENT


def _similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def score_receipt(name: str, pred: Receipt, truth: Receipt) -> Score:
    """An item is correct when name, qty and line total all match.

    Each predicted item can be claimed by at most one ground-truth item.
    """
    unused = list(pred.items)
    correct = 0
    for t in truth.items:
        best, best_sim = None, 0.0
        for p in unused:
            sim = _similar(p.name, t.name)
            if sim >= NAME_MATCH and sim > best_sim and _close(p.qty, t.qty) and _close(p.total, t.total):
                best, best_sim = p, sim
        if best is not None:
            unused.remove(best)
            correct += 1
    return Score(
        name=name,
        items_total=len(truth.items),
        items_correct=correct,
        items_extra=len(unused),
        total_ok=_close(pred.total, truth.total),
        sanity_ok=not check_receipt(pred),
    )


def summarize(scores: list[Score]) -> dict:
    ok = [s for s in scores if s.error is None]
    items = sum(s.items_total for s in scores)
    return {
        "receipts": len(scores),
        "failed": len(scores) - len(ok),
        "item_accuracy": sum(s.items_correct for s in scores) / items if items else 0.0,
        "total_accuracy": sum(s.total_ok for s in scores) / len(scores) if scores else 0.0,
        "sanity_pass_rate": sum(s.sanity_ok for s in scores) / len(scores) if scores else 0.0,
        "items_correct": sum(s.items_correct for s in scores),
        "items_total": items,
        "items_extra": sum(s.items_extra for s in scores),
    }


def render_markdown(scores: list[Score], summary: dict, model: str) -> str:
    pct = lambda x: f"{x * 100:.1f}%"  # noqa: E731
    lines = [
        "# Eval results",
        "",
        f"Model: `{model}` | Run date: {date.today().isoformat()} | Receipts: {summary['receipts']}",
        "",
        "| Metric | Result |",
        "|--------|--------|",
        f"| Item-level accuracy | {pct(summary['item_accuracy'])} ({summary['items_correct']}/{summary['items_total']} items) |",
        f"| Total accuracy | {pct(summary['total_accuracy'])} |",
        f"| Sanity check pass rate | {pct(summary['sanity_pass_rate'])} |",
        f"| Extra items hallucinated | {summary['items_extra']} |",
        f"| Extraction failures | {summary['failed']} |",
        "",
        "Item correct = name (fuzzy), qty and line total all match ground truth.",
        "",
        "| Receipt | Items | Total | Sanity | Notes |",
        "|---------|-------|-------|--------|-------|",
    ]
    for s in scores:
        note = s.error or (f"{s.items_extra} extra item(s)" if s.items_extra else "")
        lines.append(
            f"| {s.name} | {s.items_correct}/{s.items_total} | {'ok' if s.total_ok else 'WRONG'} "
            f"| {'pass' if s.sanity_ok else 'flagged'} | {note} |"
        )
    return "\n".join(lines) + "\n"


def run(directory: Path, client, model: str) -> list[Score]:
    scores = []
    for img in sorted(directory.glob("receipt_*.png")):
        truth = Receipt.model_validate(json.loads(img.with_suffix(".json").read_text()))
        try:
            pred = extract_receipt(img, client=client, model=model)
        except ExtractionError as exc:
            scores.append(Score(img.stem, len(truth.items), 0, 0, False, False, error=str(exc)[:80]))
            continue
        scores.append(score_receipt(img.stem, pred, truth))
        print(f"  {img.stem}: {scores[-1].items_correct}/{scores[-1].items_total} items", file=sys.stderr)
    return scores


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    here = Path(__file__).parent
    p.add_argument("--dir", type=Path, default=here / "receipts")
    p.add_argument("--out", type=Path, default=here / "results.md")
    p.add_argument("--model", default=None)
    args = p.parse_args(argv)

    try:
        client = get_client()
    except MissingApiKeyError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    model = args.model or os.environ.get("RECEIPT_MODEL") or DEFAULT_MODEL
    if not list(args.dir.glob("receipt_*.png")):
        generate(args.dir)
    scores = run(args.dir, client, model)
    summary = summarize(scores)
    args.out.write_text(render_markdown(scores, summary, model))
    print(render_markdown(scores, summary, model))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
