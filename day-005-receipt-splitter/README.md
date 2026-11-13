# Day 005: receipt-splitter

**Date:** 2026-11-09

## What it does

Give it a photo of a receipt and a list of names, and it tells everyone what they owe. Claude's vision model reads the line items, subtotal, tax, tip and total. The tool checks that the numbers add up, then splits the bill evenly or by who had what. Tax and tip are shared in proportion to what each person ordered, and every share is exact to the cent.

```bash
python split.py receipt.jpg --people "Jash,Ravi,Priya"
```

It prints a table plus a ready-to-paste Venmo line for each person, or JSON with `--json`.

## Why I built it

Splitting a dinner bill is a small, annoying problem. Somebody squints at the receipt, someone else opens a calculator, and the shares never quite add up to the total. I wanted to see how far a vision model gets at turning a messy photo into structured data I can trust. I also wanted to work out what code I need around the model so a misread receipt gets caught before anyone pays the wrong amount.

## Tech used

- Python 3.12+
- [Anthropic Python SDK](https://github.com/anthropics/anthropic-sdk-python), Claude vision (`claude-sonnet-5-5` by default, override with `--model` or `RECEIPT_MODEL`)
- Pydantic v2 for the receipt schema and validation
- Pillow for resizing and EXIF rotation, plus `pillow-heif` for iPhone HEIC photos
- `python-dotenv` for the API key
- `pytest`, `pytest-cov` (the Anthropic client is faked in tests, so they need no key or network)

## How extraction works

```
 receipt.jpg / .png / .heic
        |
        v
 images.py      fix EXIF rotation, shrink longest side to 1568px,
                convert HEIC to JPEG, keep under the 5 MB API limit
        |
        v
 extract.py     send the image + a strict JSON-only system prompt
                to Claude vision
        |
        v
 models.py      strip code fences, json.loads, validate with Pydantic
        |
        +-- invalid? --> send the exact validation error back to Claude,
        |                ask once more for corrected JSON
        |                (a second failure is a clear error, not a crash)
        v
 sanity.py      qty x unit price = line total?  items = subtotal?
                subtotal + tax + tip = total?   (1 cent tolerance)
        |       mismatches become WARNINGS shown to you, never silent fixes
        v
 splitter.py    even split, or per-item assignment; tax and tip shared
                in proportion; exact integer-cent rounding
        |
        v
 split.py       table + Venmo lines, or --json
```

The prompt tells Claude to copy numbers exactly as printed and never fix or recompute them. That is deliberate. If the receipt is wrong, or Claude misreads a digit, the sanity check is supposed to catch it and show you a warning. A model that quietly "corrects" a number would hide the problem.

## How to run

```bash
cd day-005-receipt-splitter
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # then put your ANTHROPIC_API_KEY in it
```

The examples below assume the venv is active (`source .venv/bin/activate`).

**Usage**

```bash
# even split, first person paid
python split.py receipt.jpg --people "Jash,Ravi,Priya"

# replace any printed tip with 20% of the subtotal
python split.py receipt.jpg --people "Jash,Ravi,Priya" --tip 20

# say who had what, item by item
python split.py receipt.jpg --people "Jash,Ravi,Priya" --assign

# machine-readable output
python split.py receipt.jpg --people "Jash,Ravi,Priya" --json

# someone other than the first person paid
python split.py receipt.jpg --people "Jash,Ravi,Priya" --payer Ravi
```

| Flag | What it does |
|------|--------------|
| `--people` | Comma-separated names (required). Names must be unique, ignoring case. |
| `--tip PCT` | Tip as a percentage of the subtotal. It replaces any tip printed on the receipt, and the total changes by the difference. |
| `--assign` | Asks who had each item. Answer with names, numbers from the list, or `all`. Shared items are split evenly between the people who had them. Prompts go to stderr, so `--assign --json` still prints clean JSON. |
| `--json` | Prints the receipt, the shares, any sanity warnings and the Venmo lines as JSON. |
| `--payer NAME` | Who paid the bill (defaults to the first name). Everyone else gets a "venmo NAME" line. |
| `--model` | Use a different Claude model. |

Supported images: `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`.

**Tests**

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest          # 131 tests, 99% coverage, no API calls
.venv/bin/python -m pytest --cov-fail-under=85   # fail if coverage drops under 85%
```

**Evals** (real API calls, one per receipt)

```bash
python evals/generate.py    # 10 synthetic receipt images + ground truth JSON in evals/receipts/
python evals/run.py         # extract each one, score it, write evals/results.md
```

## Sample output

These are real runs on `evals/receipts/receipt_04.png`, a synthetic receipt from `evals/generate.py`. It is slightly rotated, blurred and noisy, and has 6 items with an 18% tip printed on it.

**Even split**

```
$ python split.py evals/receipts/receipt_04.png --people "Jash,Ravi,Priya"
BLUE DOOR PIZZA  (2026-09-15)
Split: even

Name   Subtotal   Tax    Tip  Total
-----  --------  ----  -----  -----
Jash      19.32  1.72   3.48  24.52
Ravi      19.32  1.71   3.48  24.51
Priya     19.31  1.71   3.47  24.49
-----  --------  ----  -----  -----
TOTAL     57.95  5.14  10.43  73.52

Jash: paid the bill, own share $24.52
Ravi: venmo Jash $24.51 "BLUE DOOR PIZZA 2026-09-15 split"
Priya: venmo Jash $24.49 "BLUE DOOR PIZZA 2026-09-15 split"
```

**Overriding the tip with `--tip 20`**

```
$ python split.py evals/receipts/receipt_04.png --people "Jash,Ravi,Priya" --tip 20
BLUE DOOR PIZZA  (2026-09-15)
Split: even

Name   Subtotal   Tax    Tip  Total
-----  --------  ----  -----  -----
Jash      19.32  1.72   3.87  24.91
Ravi      19.32  1.71   3.86  24.89
Priya     19.31  1.71   3.86  24.88
-----  --------  ----  -----  -----
TOTAL     57.95  5.14  11.59  74.68

Jash: paid the bill, own share $24.91
Ravi: venmo Jash $24.89 "BLUE DOOR PIZZA 2026-09-15 split"
Priya: venmo Jash $24.88 "BLUE DOOR PIZZA 2026-09-15 split"
```

**Who had what, with `--assign --payer Ravi`**

The answers, one per item: Guacamole `all`, Miso Soup `Ravi,Priya`, Sparkling Water `all`, Ramen `Ravi`, Croissant `Priya`, Craft Beer `1` (Jash).

```
$ python split.py evals/receipts/receipt_04.png --people "Jash,Ravi,Priya" --assign --payer Ravi
...
BLUE DOOR PIZZA  (2026-09-15)
Split: assigned

Name   Subtotal   Tax    Tip  Total
-----  --------  ----  -----  -----
Jash      15.12  1.34   2.72  19.18
Ravi      26.62  2.36   4.79  33.77
Priya     16.21  1.44   2.92  20.57
-----  --------  ----  -----  -----
TOTAL     57.95  5.14  10.43  73.52

Jash: venmo Ravi $19.18 "BLUE DOOR PIZZA 2026-09-15 split"
Ravi: paid the bill, own share $33.77
Priya: venmo Ravi $20.57 "BLUE DOOR PIZZA 2026-09-15 split"
```

**JSON, with `--tip 20 --json`** (items trimmed to the first two)

```json
{
  "merchant": "BLUE DOOR PIZZA",
  "date": "2026-09-15",
  "mode": "even",
  "payer": "Jash",
  "tip_override_percent": 20.0,
  "items": [
    {"name": "Guacamole", "qty": 3.0, "unit_price": 6.95, "total": 20.85},
    {"name": "Miso Soup", "qty": 2.0, "unit_price": 3.75, "total": 7.5},
    ...
  ],
  "subtotal": 57.95,
  "tax": 5.14,
  "tip": 11.59,
  "total": 74.68,
  "warnings": [],
  "shares": [
    {"name": "Jash", "subtotal": 19.32, "tax": 1.72, "tip": 3.87, "adjustment": 0.0, "total": 24.91},
    {"name": "Ravi", "subtotal": 19.32, "tax": 1.71, "tip": 3.86, "adjustment": 0.0, "total": 24.89},
    {"name": "Priya", "subtotal": 19.31, "tax": 1.71, "tip": 3.86, "adjustment": 0.0, "total": 24.88}
  ],
  "venmo": [
    "Jash: paid the bill, own share $24.91",
    "Ravi: venmo Jash $24.89 \"BLUE DOOR PIZZA 2026-09-15 split\"",
    "Priya: venmo Jash $24.88 \"BLUE DOOR PIZZA 2026-09-15 split\""
  ]
}
```

All six items, the subtotal, tax, tip and total match the ground truth for this receipt.

## How the rounding works

Money never touches a float. Amounts are parsed as `Decimal` and then converted to integer cents, so the split works on whole numbers.

1. **Weights.** In an even split everyone has weight 1. In `--assign` mode, each item's cents are divided evenly among the people who had it, and a person's weight is the sum of their parts (kept as exact fractions).
2. **Each component is split separately.** The subtotal, tax, tip, and any adjustment are each divided in proportion to the weights. So whoever ordered more pays more tax and more tip, which is how the restaurant charged it in the first place.
3. **Largest remainder method.** Everyone gets the floor of their exact share in cents. The cents left over go one at a time to the people with the largest fractional remainders, with ties going to whoever is listed first. Each component therefore adds up exactly, and so do the totals.

Worked example from the even split above: the $57.95 subtotal is 5795 cents, and 5795 / 3 = 1931.67 each. Everyone gets 1931, which leaves 2 cents over. All three remainders are the same (0.67), so the first two names get one each: 19.32, 19.32, 19.31. Tax (514 cents) leaves 1 cent over, so it goes to Jash. The person totals sum to $73.52 exactly.

If a receipt's printed total does not equal subtotal + tax + tip, the gap goes into an **Adjust** column. It is split by the same weights, so everyone still pays a share of what was actually charged, and the warning above the table tells you to check the photo.

## Eval results

`evals/generate.py` draws 10 synthetic receipts with Pillow. It uses random items, quantities of 1 to 3, five different tax rates and a printed tip on two of them. Each image is slightly rotated, sometimes blurred, and given added noise. `evals/run.py` runs the real extraction on each one and compares it with the ground truth. Real output from `evals/results.md`:

Model: `claude-sonnet-5-5` | Run date: 2026-11-09 | Receipts: 10

| Metric | Result |
|--------|--------|
| Item-level accuracy | 100.0% (53/53 items) |
| Total accuracy | 100.0% |
| Sanity check pass rate | 100.0% |
| Extra items hallucinated | 0 |
| Extraction failures | 0 |

Item correct = name (fuzzy), qty and line total all match ground truth.

| Receipt | Items | Total | Sanity | Notes |
|---------|-------|-------|--------|-------|
| receipt_01 | 6/6 | ok | pass |  |
| receipt_02 | 3/3 | ok | pass |  |
| receipt_03 | 7/7 | ok | pass |  |
| receipt_04 | 6/6 | ok | pass |  |
| receipt_05 | 6/6 | ok | pass |  |
| receipt_06 | 6/6 | ok | pass |  |
| receipt_07 | 5/5 | ok | pass |  |
| receipt_08 | 3/3 | ok | pass |  |
| receipt_09 | 7/7 | ok | pass |  |
| receipt_10 | 4/4 | ok | pass |  |

A caveat: these receipts are clean, typed and short. A perfect score here says the pipeline works end to end. It does not prove anything about crumpled thermal paper, handwritten tips or a 40-line grocery receipt. That is what the sanity check is for.

## What I learned

- **Validation is the real interface to the model.** Pydantic turns "the model replied" into "I have a receipt or a precise error message". Sending that exact error back for one more attempt gives the model something concrete to fix, which beats a blind retry loop.
- **Don't let the model do the math.** Asking Claude to copy numbers exactly and doing all arithmetic in code keeps errors visible. The sanity check can only catch a misread if the model didn't "helpfully" make the numbers agree.
- **Rounding is a fairness problem.** Rounding each share on its own can leave the group a cent short or over. Splitting integer cents with the largest remainder method always sums exactly, and splitting tax and tip per component keeps them proportional to what each person ate.
- **Images need preparing before the model sees them.** Phone photos arrive sideways (EXIF orientation), huge, or as HEIC. Fixing rotation, capping the longest side at 1568px and converting HEIC to JPEG happen before the API call, while small, already-fine files pass through untouched.
- **Synthetic evals are cheap and honest about their limits.** Generating receipts with known ground truth gave me a repeatable accuracy number from one command. It also showed me what it can't measure, which is real-world mess.

## Ideas to extend

- Evaluate on real photos (crumpled, angled, low light) with hand-labelled ground truth
- Handle discounts, service charges and multiple tax lines as separate, assignable lines
- Ask Claude for a confidence score per line and flag low-confidence lines in the table
- Remember people and payment handles between runs, and generate Venmo deep links
- Support other currencies and locale number formats (`12,50`)
- Add a small web UI: snap a photo, tap names onto items

## Author

**Jashwanth Neela** · [GitHub](https://github.com/NJashwanth)
