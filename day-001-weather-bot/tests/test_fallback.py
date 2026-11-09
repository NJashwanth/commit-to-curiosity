from datetime import date

import pytest

from conftest import make_rows
from weather import WeatherError, describe, format_forecast, select_days

THURSDAY = date(2026, 11, 5)
ROWS = make_rows(THURSDAY)  # Thu Nov 5 .. Thu Nov 12


def test_output_has_city_dates_temps():
    out = format_forecast("Detroit, Michigan, US", select_days(ROWS, "tomorrow", THURSDAY))
    assert "Detroit, Michigan, US" in out
    assert "Fri Nov 06" in out
    assert "41°F to 61°F" in out  # row index 1: min 41, max 61
    assert "10% chance" in out


@pytest.mark.parametrize("code,emoji,text", [
    (0, "☀️", "Clear sky"), (3, "☁️", "Overcast"), (61, "🌦️", "Light rain"),
    (73, "❄️", "Snow"), (95, "⛈️", "Thunderstorm"), (45, "🌫️", "Fog"),
])
def test_emoji_per_weather_code(code, emoji, text):
    assert describe(code) == (emoji, text)
    row = make_rows(THURSDAY, codes=(code,))
    out = format_forecast("X", row)
    assert emoji in out and text in out


def test_unknown_code_has_fallback_icon():
    assert describe(12345) == ("🌡️", "Unknown")


def test_imperial_units():
    out = format_forecast("X", ROWS[:1], "imperial")
    assert "°F" in out and "mph" in out and " in)" in out
    assert "°C" not in out and "km/h" not in out


def test_metric_units():
    out = format_forecast("X", ROWS[:1], "metric")
    assert "°C" in out and "km/h" in out and " mm)" in out
    assert "°F" not in out and "mph" not in out


def test_null_precipitation_does_not_crash():
    row = make_rows(THURSDAY, codes=(0,))
    row[0]["precipitation_probability_max"] = None
    row[0]["precipitation_sum"] = None
    assert "0% chance" in format_forecast("X", row)


def test_weekend_returns_only_saturday_and_sunday():
    days = select_days(ROWS, "weekend", THURSDAY)
    assert [date.fromisoformat(r["time"]).strftime("%a") for r in days] == ["Sat", "Sun"]


def test_weekend_on_saturday_includes_today_and_sunday():
    sat = date(2026, 11, 7)
    days = select_days(make_rows(sat), "weekend", sat)
    assert [r["time"] for r in days] == ["2026-11-07", "2026-11-08"]


def test_weekend_on_sunday_is_only_today():
    sun = date(2026, 11, 8)
    assert [r["time"] for r in select_days(make_rows(sun), "weekend", sun)] == ["2026-11-08"]


def test_today_tomorrow_week():
    assert [r["time"] for r in select_days(ROWS, "today", THURSDAY)] == ["2026-11-05"]
    assert [r["time"] for r in select_days(ROWS, "tomorrow", THURSDAY)] == ["2026-11-06"]
    assert len(select_days(ROWS, "week", THURSDAY)) == 7


def test_timeframe_outside_forecast_raises():
    with pytest.raises(WeatherError, match="doesn't cover"):
        select_days(ROWS, "today", date(2027, 1, 1))


def test_weekday_and_n_day_frames():
    assert [r["time"] for r in select_days(ROWS, "monday", THURSDAY)] == ["2026-11-09"]
    assert [r["time"] for r in select_days(ROWS, "in 2 days", THURSDAY)] == ["2026-11-07"]
    assert len(select_days(ROWS, "next 5 days", THURSDAY)) == 5


def test_frame_past_forecast_end_raises_instead_of_truncating():
    with pytest.raises(WeatherError, match="doesn't cover"):
        select_days(ROWS, "next 14 days", THURSDAY)
    with pytest.raises(WeatherError, match="doesn't cover"):
        select_days(ROWS, "in 10 days", THURSDAY)


def test_today_defaults_to_forecast_first_day():
    """Open-Meteo starts the forecast at the city's local today, which may differ from ours."""
    assert select_days(ROWS, "today")[0]["time"] == "2026-11-05"
    assert select_days(ROWS, "tomorrow")[0]["time"] == "2026-11-06"


def test_hourly_block_does_not_change_plain_output():
    row = dict(ROWS[0], hourly={"hour": [0], "temperature_2m": [40.0]})
    assert format_forecast("X", [row]) == format_forecast("X", ROWS[:1])
