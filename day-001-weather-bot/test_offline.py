"""Offline checks: parsing, day selection, formatting and error handling. Run: python test_offline.py"""
from datetime import date
import io, contextlib
from unittest import mock

import bot
from qparse import parse_question
from weather import WeatherError, format_forecast, select_days
import requests

CASES = {
    "Do I need a jacket in Detroit tomorrow?": ("Detroit", "tomorrow"),
    "Weekend forecast for Austin": ("Austin", "weekend"),
    "Will it rain in New York City next 7 days?": ("New York City", "week"),
    "Forecast for St. Louis this weekend": ("St. Louis", "weekend"),
    "What's the weather in Seattle?": ("Seattle", "today"),
    "Is it nice out": (None, "today"),
}
for q, exp in CASES.items():
    assert parse_question(q) == exp, (q, parse_question(q), exp)

# Synthetic data (not real weather) just to exercise the logic.
rows = [{"time": f"2026-11-{d:02d}", "weather_code": c, "temperature_2m_max": 50 + d, "temperature_2m_min": 38 + d,
         "apparent_temperature_max": 45 + d, "precipitation_probability_max": p, "precipitation_sum": 0.1 * p / 10,
         "wind_speed_10m_max": 12} for d, c, p in [(5, 3, 10), (6, 61, 70), (7, 0, 0), (8, 2, 5), (9, 95, 90), (10, 0, 0), (11, 1, 0), (12, 3, 20)]]
assert [r["time"] for r in select_days(rows, "weekend", date(2026, 11, 5))] == ["2026-11-07", "2026-11-08"]
assert [r["time"] for r in select_days(rows, "weekend", date(2026, 11, 8))] == ["2026-11-08"]
assert len(select_days(rows, "week", date(2026, 11, 5))) == 7
assert select_days(rows, "tomorrow", date(2026, 11, 5))[0]["time"] == "2026-11-06"
print(format_forecast("Testville, XX", select_days(rows, "tomorrow", date(2026, 11, 5))))

def run(args, env=None):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), mock.patch.dict("os.environ", env or {}, clear=False):
        code = bot.main(args)
    return code, out.getvalue(), err.getvalue()

with mock.patch("bot.load_dotenv"):
    code, _, err = run(["Is it nice out"]); assert code == 2 and "which city" in err
    with mock.patch("bot.geocode", side_effect=WeatherError("I couldn't find a place called 'Zzzz'.")):
        code, _, err = run(["weather in Zzzz"]); assert code == 1 and "couldn't find" in err
    with mock.patch("weather.requests.get", side_effect=requests.exceptions.ConnectionError()):
        code, _, err = run(["weather in Detroit"]); assert code == 1 and "network" in err
print("all offline checks passed")
