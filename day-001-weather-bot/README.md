# Day 001: weather-bot

**Date:** 2026-11-05

## What it does

A command line weather bot that takes a plain English question, finds the city and time frame in it, pulls the forecast from Open-Meteo, and answers. With an `ANTHROPIC_API_KEY` set, Claude turns the raw forecast into a short, practical answer (what to wear, umbrella or not, best time to go out). Without a key it prints a clean forecast with emoji icons.

## Why I built it

Weather apps make me dig for the one thing I actually want to know: do I need a jacket? I wanted to see how far a tiny amount of parsing plus one well-framed LLM call gets you, and what the same tool looks like with and without the AI step.

## Tech used

- Python 3, `requests`, `python-dotenv`
- Open-Meteo geocoding and forecast APIs (no key needed)
- Anthropic Messages API (optional, `claude-haiku-5-5` by default)

## How to run

```bash
cd day-001-weather-bot
pip install -r requirements.txt
cp .env.example .env        # optional: add ANTHROPIC_API_KEY for AI mode

python bot.py "Do I need a jacket in Detroit tomorrow?"
python bot.py "Weekend forecast for Austin" --units metric
python bot.py "Will it rain in Seattle next 7 days?" --no-ai
```

Files: `bot.py` (CLI), `ai.py` (Claude call and prompt), `qparse.py` (city and time frame), `weather.py` (Open-Meteo, formatting).

### Sample output (fallback mode)

The block below is the real formatter run on synthetic numbers (the build sandbox could not reach Open-Meteo), so it shows the layout, not a real forecast:

```
📍 Testville, XX

🌦️  Fri Nov 06: Light rain, 44°F to 56°F (feels up to 51°F)
     ☔ 70% chance (0.7 in)   💨 up to 12 mph
```

AI mode replaces this with 2 to 4 sentences, for example "Grab a light rain jacket tomorrow. ..." (not yet run against live data).

## Running tests

```bash
cd day-001-weather-bot
pip install -r requirements-dev.txt
python -m pytest                      # runs with coverage, config in pytest.ini
python -m pytest --cov-fail-under=85  # what CI enforces
```

No test touches the network: Open-Meteo and the Claude API are mocked with `responses`, and any unmocked request raises. The suite covers question parsing, the Open-Meteo client (success, unknown city, params, timeouts, 5xx, bad JSON), fallback formatting and day selection, AI mode and its fallback, and the CLI end to end. Currently 76 tests at 99% coverage. GitHub Actions runs them on pushes that touch this folder (`.github/workflows/day-001-tests.yml`).

## What I learned

- Open-Meteo returns column-oriented daily arrays, so a small reshaping step makes the data much easier to select from and to hand to an LLM.
- A regex that looks for "in/for <city>" covers most questions, but abbreviations like "St. Louis" will fool naive punctuation rules.
- Writing the error-path tests exposed a real bug: in current `requests`, invalid JSON raises an exception that is also a `RequestException`, so handler order decided which message the user saw.
- Failing cleanly matters: unknown city, no network and unclear questions each get a one-line message and a distinct exit code.

## Ideas to extend

- Use the LLM to extract the city and time frame for harder questions.
- Disambiguate cities (Portland, OR vs ME) by showing the top matches.
- Hourly "best time to go outside" using the hourly data already fetched.
- Cache geocoding results.
