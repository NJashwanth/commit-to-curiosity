"""Pydantic models for a parsed receipt."""

from __future__ import annotations

import json
import re
from datetime import date as _date
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field, ValidationError, field_validator


class ReceiptParseError(ValueError):
    """The model's output was not valid receipt JSON."""


class LineItem(BaseModel):
    name: str = Field(min_length=1)
    qty: Decimal = Field(default=Decimal(1), gt=0)
    unit_price: Decimal
    total: Decimal

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v


class Receipt(BaseModel):
    merchant: str = Field(min_length=1)
    date: Optional[str] = None
    items: list[LineItem] = Field(min_length=1)
    subtotal: Decimal
    tax: Decimal = Decimal(0)
    tip: Optional[Decimal] = None
    total: Decimal

    @field_validator("date")
    @classmethod
    def _check_date(cls, v: Optional[str]) -> Optional[str]:
        if v is None or not v.strip():
            return None
        try:
            return _date.fromisoformat(v.strip()).isoformat()
        except ValueError:
            raise ValueError("date must be YYYY-MM-DD or null") from None


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _extract_json_text(raw: str) -> str:
    """Strip code fences and surrounding prose, keeping the outermost {...}."""
    text = _FENCE.sub("", raw.strip())
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end < start:
        raise ReceiptParseError("response contains no JSON object")
    return text[start : end + 1]


def parse_receipt_json(raw: str) -> Receipt:
    """Parse model output into a Receipt or raise ReceiptParseError.

    The error message is written to be fed back to the model on retry.
    """
    try:
        data = json.loads(_extract_json_text(raw))
    except json.JSONDecodeError as exc:
        raise ReceiptParseError(f"invalid JSON: {exc}") from exc
    try:
        return Receipt.model_validate(data)
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or 'root'}: {e['msg']}"
            for e in exc.errors()
        )
        raise ReceiptParseError(f"schema validation failed: {problems}") from exc
