"""Vision extraction: image in, validated Receipt out."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

from images import prepare_image
from models import Receipt, ReceiptParseError, parse_receipt_json

DEFAULT_MODEL = "claude-sonnet-5-5"
MAX_TOKENS = 2048

SYSTEM_PROMPT = """You extract data from photos of receipts.
Reply with ONE JSON object and nothing else (no prose, no code fences):
{
  "merchant": string,
  "date": "YYYY-MM-DD" or null,
  "items": [{"name": string, "qty": number, "unit_price": number, "total": number}],
  "subtotal": number,
  "tax": number,
  "tip": number or null,
  "total": number
}
Rules:
- Money values are plain numbers in the receipt's currency, no symbols.
- "total" on an item is the line total (qty * unit_price) as printed.
- If qty is not printed use 1 and set unit_price equal to the line total.
- "tip" is only a tip/gratuity amount that is PRINTED on the receipt, otherwise null.
- "tax" is the sum of all tax lines, 0 if none.
- Discounts are items with a negative total.
- Copy numbers exactly as printed. Never fix, guess, or recompute values."""

USER_PROMPT = "Extract this receipt as JSON."


class MissingApiKeyError(RuntimeError):
    """ANTHROPIC_API_KEY is not set."""


class ExtractionError(RuntimeError):
    """The model never produced valid receipt JSON."""


def get_client():
    """Build an Anthropic client, with a clear message if the key is missing."""
    load_dotenv()
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise MissingApiKeyError(
            "ANTHROPIC_API_KEY is not set. Export it or put it in a .env file "
            "(see .env.example). Get a key at https://console.anthropic.com/"
        )
    import anthropic

    return anthropic.Anthropic(api_key=key)


def _response_text(response) -> str:
    return "".join(
        block.text for block in response.content if getattr(block, "type", "") == "text"
    )


def extract_receipt(image_path: str | Path, client=None, model: str | None = None) -> Receipt:
    """Send the receipt image to Claude and return a validated Receipt.

    If the first reply fails validation, the validation error is sent back
    once and the model gets a second attempt. A second failure raises
    ExtractionError.
    """
    model = model or os.environ.get("RECEIPT_MODEL") or DEFAULT_MODEL
    client = client or get_client()
    image = prepare_image(image_path)

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.media_type,
                        "data": image.b64,
                    },
                },
                {"type": "text", "text": USER_PROMPT},
            ],
        }
    ]

    last_error: ReceiptParseError | None = None
    for attempt in range(2):
        response = client.messages.create(
            model=model, max_tokens=MAX_TOKENS, system=SYSTEM_PROMPT, messages=messages
        )
        text = _response_text(response)
        try:
            return parse_receipt_json(text)
        except ReceiptParseError as exc:
            last_error = exc
            messages = messages + [
                {"role": "assistant", "content": text or "(empty reply)"},
                {
                    "role": "user",
                    "content": (
                        f"That reply was not valid: {exc}. "
                        "Reply again with ONLY the corrected JSON object."
                    ),
                },
            ]
    raise ExtractionError(
        f"Could not get valid receipt JSON after 2 attempts. Last error: {last_error}"
    )
