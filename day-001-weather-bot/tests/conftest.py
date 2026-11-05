from datetime import date, timedelta

import pytest
import responses as responses_lib

from weather import FORECAST_URL, GEOCODE_URL

DAILY_KEYS = ["weather_code", "temperature_2m_max", "temperature_2m_min", "apparent_temperature_max",
              "precipitation_probability_max", "precipitation_sum", "wind_speed_10m_max"]


def make_rows(start, codes=(0, 61, 3, 95, 73, 2, 1, 0)):
    """Synthetic daily rows (not real weather) starting at `start`."""
    rows = []
    for i, code in enumerate(codes):
        d = start + timedelta(days=i)
        rows.append({"time": d.isoformat(), "weather_code": code, "temperature_2m_max": 60.0 + i,
                     "temperature_2m_min": 40.0 + i, "apparent_temperature_max": 58.0 + i,
                     "precipitation_probability_max": 10 * i, "precipitation_sum": 0.1 * i,
                     "wind_speed_10m_max": 12.0 + i})
    return rows


def to_api_daily(rows):
    """Open-Meteo returns column-oriented arrays."""
    daily = {"time": [r["time"] for r in rows]}
    for k in DAILY_KEYS:
        daily[k] = [r[k] for r in rows]
    return {"daily": daily}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """No real key, no real .env file, ever."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    monkeypatch.setattr("bot.load_dotenv", lambda *a, **k: None)


@pytest.fixture
def mocked():
    """Any request that is not explicitly registered raises, so tests cannot hit the network."""
    with responses_lib.RequestsMock(assert_all_requests_are_fired=False) as rsps:
        yield rsps


@pytest.fixture
def detroit(mocked):
    mocked.add(responses_lib.GET, GEOCODE_URL, json={"results": [
        {"name": "Detroit", "admin1": "Michigan", "country_code": "US", "latitude": 42.33, "longitude": -83.05}]})
    return mocked


@pytest.fixture
def forecast(detroit):
    rows = make_rows(date.today())
    detroit.add(responses_lib.GET, FORECAST_URL, json=to_api_daily(rows))
    return rows
