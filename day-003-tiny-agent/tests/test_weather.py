import pytest
import requests

import weather
from errors import ToolError

GEO_OK = {"results": [{"name": "Detroit", "admin1": "Michigan", "country": "United States",
                       "latitude": 42.33, "longitude": -83.05}]}


def make_forecast(start_hour=20, temp_unit_offset=0):
    """Two days of hourly data starting at midnight on 2026-11-07, current time 20:15."""
    times, temps, rain, codes = [], [], [], []
    for day in ("2026-11-07", "2026-11-08"):
        for h in range(24):
            times.append(f"{day}T{h:02d}:00")
            temps.append(50 - h * 0.5 + temp_unit_offset)
            rain.append(80 if (day == "2026-11-08" and 2 <= h <= 4) else 10)
            codes.append(63 if rain[-1] >= 80 else 3)
    return {
        "current": {"time": f"2026-11-07T{start_hour:02d}:15", "temperature_2m": 41.2,
                    "apparent_temperature": 37.0, "weather_code": 3, "wind_speed_10m": 8.5},
        "hourly": {"time": times, "temperature_2m": temps, "precipitation_probability": rain, "weather_code": codes},
    }


class FakeResponse:
    def __init__(self, payload, status=200, bad_json=False):
        self.payload, self.status, self.bad_json = payload, status, bad_json

    def raise_for_status(self):
        if self.status >= 400:
            raise requests.HTTPError(f"{self.status} error")

    def json(self):
        if self.bad_json:
            raise ValueError("not json")
        return self.payload


@pytest.fixture
def fake_get(monkeypatch):
    """Route requests.get by URL. Tests set .geo and .forecast, and read .calls."""
    state = type("S", (), {})()
    state.geo, state.forecast, state.calls = FakeResponse(GEO_OK), FakeResponse(make_forecast()), []

    def _get(url, params=None, timeout=None):
        state.calls.append((url, params))
        resp = state.geo if url == weather.GEOCODE_URL else state.forecast
        if isinstance(resp, Exception):
            raise resp
        return resp

    monkeypatch.setattr(weather.requests, "get", _get)
    return state


def test_parses_current_and_next_24h(fake_get):
    out = weather.get_weather("Detroit")
    assert out["location"] == "Detroit, Michigan, United States"
    assert out["current"]["temp"] == "41.2F"
    assert out["current"]["feels_like"] == "37.0F"
    assert out["current"]["conditions"] == "overcast"
    assert out["current"]["wind"] == "8.5 mph"
    nxt = out["next_24h"]
    # 20:00 today through 19:00 tomorrow: includes the 80% rain block at 02:00 to 04:00.
    assert nxt["max_rain_chance_pct"] == 80
    assert nxt["rainy_hours"] == 3
    assert nxt["every_3h"][0]["time"] == "2026-11-07T20:00"
    assert len(nxt["every_3h"]) == 8
    assert [r["time"] for r in nxt["every_3h"] if r["conditions"] == "rain"] == ["2026-11-08T02:00"]
    assert nxt["temp_range"].endswith("F")


def test_metric_units_sent_to_api_and_labelled(fake_get):
    out = weather.get_weather("Detroit", units="metric")
    forecast_params = fake_get.calls[-1][1]
    assert forecast_params["temperature_unit"] == "celsius"
    assert forecast_params["wind_speed_unit"] == "kmh"
    assert out["current"]["temp"].endswith("C")
    assert out["current"]["wind"].endswith("km/h")


def test_imperial_is_default(fake_get):
    weather.get_weather("Detroit")
    assert fake_get.calls[-1][1]["temperature_unit"] == "fahrenheit"


def test_geocoding_uses_the_city(fake_get):
    weather.get_weather("  Detroit  ")
    url, params = fake_get.calls[0]
    assert url == weather.GEOCODE_URL and params["name"] == "Detroit"


@pytest.mark.parametrize("geo", [{}, {"results": []}, {"results": None}])
def test_unknown_city(fake_get, geo):
    fake_get.geo = FakeResponse(geo)
    with pytest.raises(ToolError, match="No location found for 'Atlantis'") as exc:
        weather.get_weather("Atlantis")
    assert exc.value.retryable is False


def test_network_error_is_retryable(fake_get):
    fake_get.geo = requests.ConnectionError("dns failure")
    with pytest.raises(ToolError, match="Could not reach Open-Meteo") as exc:
        weather.get_weather("Detroit")
    assert exc.value.retryable is True


def test_timeout_on_forecast_is_retryable(fake_get):
    fake_get.forecast = requests.Timeout("slow")
    with pytest.raises(ToolError, match="Could not reach") as exc:
        weather.get_weather("Detroit")
    assert exc.value.retryable is True


def test_http_error_status(fake_get):
    fake_get.forecast = FakeResponse({}, status=500)
    with pytest.raises(ToolError, match="Could not reach"):
        weather.get_weather("Detroit")


def test_unreadable_json(fake_get):
    fake_get.geo = FakeResponse(None, bad_json=True)
    with pytest.raises(ToolError, match="unreadable"):
        weather.get_weather("Detroit")


def test_missing_fields_in_forecast(fake_get):
    fake_get.forecast = FakeResponse({"current": {"time": "2026-11-07T20:15"}})
    with pytest.raises(ToolError, match="missing expected fields"):
        weather.get_weather("Detroit")


def test_no_hourly_rows_left(fake_get):
    data = make_forecast()
    data["current"]["time"] = "2027-01-01T00:00"
    fake_get.forecast = FakeResponse(data)
    with pytest.raises(ToolError, match="no hourly forecast"):
        weather.get_weather("Detroit")


def test_null_values_in_hourly_data_are_tolerated(fake_get):
    data = make_forecast()
    data["hourly"]["temperature_2m"] = [None] * 48
    data["hourly"]["precipitation_probability"] = [None] * 48
    fake_get.forecast = FakeResponse(data)
    out = weather.get_weather("Detroit")
    assert out["next_24h"]["temp_range"] == "unknown"
    assert out["next_24h"]["max_rain_chance_pct"] == 0


@pytest.mark.parametrize("city", ["", "   ", None, 5])
def test_bad_city_input(city):
    with pytest.raises(ToolError, match="city name"):
        weather.get_weather(city)


def test_bad_units():
    with pytest.raises(ToolError, match="units"):
        weather.get_weather("Detroit", units="kelvin")


def test_describe_known_and_unknown_codes():
    assert weather.describe(95) == "thunderstorm"
    assert weather.describe(1234) == "weather code 1234"


def test_location_label_skips_missing_parts(fake_get):
    fake_get.geo = FakeResponse({"results": [{"name": "Paris", "latitude": 1, "longitude": 2}]})
    assert weather.geocode("Paris")["label"] == "Paris"
