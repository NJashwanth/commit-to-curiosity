#!/usr/bin/env python3
"""Ask a weather question in plain English.

    python bot.py "Do I need a jacket in Detroit tomorrow?"
    python bot.py "Weekend forecast for Austin" --units metric
"""
import argparse
import json
import os
import sys

import requests
from dotenv import load_dotenv

from qparse import parse_question
from weather import WeatherError, daily_rows, fetch_forecast, format_forecast, geocode, select_days

DEFAULT_MODEL = "claude-haiku-5-5"
API_URL = "https://api.anthropic.com/v1/messages"

SYSTEM_PROMPT = (
    "You are a friendly, practical weather assistant. You get the user's question and raw forecast "
    "data. Answer in 2 to 4 short sentences: say what to wear, whether to bring an umbrella, and the "
    "best time of day to be outside when relevant. Use the units given. Be specific, not generic. "
    "No markdown headings, at most one emoji."
)


def ask_claude(question, place, rows, units, api_key):
    payload = {
        "model": os.getenv("ANTHROPIC_MODEL", DEFAULT_MODEL),
        "max_tokens": 400,
        "system": SYSTEM_PROMPT,
        "messages": [{
            "role": "user",
            "content": f"Question: {question}\nPlace: {place}\nUnits: {units}\n"
                       f"Forecast (JSON): {json.dumps(rows)}",
        }],
    }
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    resp = requests.post(API_URL, headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    return "".join(b.get("text", "") for b in resp.json().get("content", [])).strip()


def main(argv=None):
    load_dotenv()
    ap = argparse.ArgumentParser(description="Answer natural weather questions with Open-Meteo.")
    ap.add_argument("question", nargs="+", help='e.g. "Do I need a jacket in Detroit tomorrow?"')
    ap.add_argument("--units", choices=["metric", "imperial"], default="imperial")
    ap.add_argument("--no-ai", action="store_true", help="skip Claude even if ANTHROPIC_API_KEY is set")
    args = ap.parse_args(argv)
    question = " ".join(args.question).strip()

    city, timeframe = parse_question(question)
    if not city:
        print("I couldn't tell which city you mean. Try something like: "
              '"Do I need a jacket in Detroit tomorrow?"', file=sys.stderr)
        return 2

    try:
        loc = geocode(city)
        rows = select_days(daily_rows(fetch_forecast(loc["lat"], loc["lon"], args.units)), timeframe)
    except WeatherError as exc:
        print(f"Sorry: {exc}", file=sys.stderr)
        return 1

    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if api_key and not args.no_ai:
        try:
            print(ask_claude(question, loc["name"], rows, args.units, api_key))
            return 0
        except requests.exceptions.RequestException as exc:
            print(f"(AI answer unavailable: {exc.__class__.__name__}. Showing the plain forecast.)\n",
                  file=sys.stderr)

    print(format_forecast(loc["name"], rows, args.units))
    return 0


if __name__ == "__main__":
    sys.exit(main())
