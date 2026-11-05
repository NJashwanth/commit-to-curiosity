"""Claude call, kept in one small module so the rest of the bot never touches the API."""
import json
import os

import requests

DEFAULT_MODEL = "claude-haiku-5-5"
API_URL = "https://api.anthropic.com/v1/messages"

SYSTEM_PROMPT = (
    "You are a friendly, practical weather assistant. You get the user's question and raw forecast "
    "data. Answer in 2 to 4 short sentences: say what to wear, whether to bring an umbrella, and the "
    "best time of day to be outside when relevant. Use the units given. Be specific, not generic. "
    "No markdown headings, at most one emoji."
)


def build_prompt(question, place, rows, units):
    """Pure function: the user message sent to Claude."""
    return (f"Question: {question}\nPlace: {place}\nUnits: {units}\n"
            f"Forecast (JSON): {json.dumps(rows)}")


def ask_claude(question, place, rows, units, api_key):
    payload = {
        "model": os.getenv("ANTHROPIC_MODEL", DEFAULT_MODEL),
        "max_tokens": 400,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": build_prompt(question, place, rows, units)}],
    }
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    resp = requests.post(API_URL, headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    return "".join(b.get("text", "") for b in resp.json().get("content", [])).strip()
