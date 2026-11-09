#!/usr/bin/env python3
"""Ask a weather question in plain English.

    python bot.py "Do I need a jacket in Detroit tomorrow?"
    python bot.py "Weekend forecast for Austin" --units metric
"""
import argparse
import os
import sys

import requests
from dotenv import load_dotenv

from ai import ask_claude
from qparse import QuestionError, parse_question, timeframe_was_guessed
from weather import WeatherError, daily_rows, fetch_forecast, format_forecast, geocode, select_days


def build_parser():
    ap = argparse.ArgumentParser(description="Answer natural weather questions with Open-Meteo.")
    ap.add_argument("question", nargs="*", help='e.g. "Do I need a jacket in Detroit tomorrow?"')
    ap.add_argument("--units", choices=["metric", "imperial"], default="imperial")
    ap.add_argument("--no-ai", action="store_true", help="skip Claude even if ANTHROPIC_API_KEY is set")
    return ap


def main(argv=None):
    load_dotenv()
    args = build_parser().parse_args(argv)
    question = " ".join(args.question).strip()

    try:
        city, timeframe = parse_question(question)
    except QuestionError as exc:
        print(exc, file=sys.stderr)
        return 2
    if timeframe_was_guessed(question):
        print("(I couldn't tell which day you meant, so this is today's forecast. Try: tomorrow, Friday, "
              "this weekend, in 3 days, next 5 days.)\n", file=sys.stderr)

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
