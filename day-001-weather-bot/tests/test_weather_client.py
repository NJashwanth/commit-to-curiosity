import pytest
import requests
import responses

from weather import (FORECAST_URL, GEOCODE_URL, WeatherError, build_forecast_params, daily_rows,
                     fetch_forecast, geocode)


def test_geocode_success(mocked):
    mocked.add(responses.GET, GEOCODE_URL, json={"results": [
        {"name": "Austin", "admin1": "Texas", "country_code": "US", "latitude": 30.27, "longitude": -97.74}]})
    loc = geocode("Austin")
    assert loc == {"name": "Austin, Texas, US", "lat": 30.27, "lon": -97.74}
    assert "name=Austin" in mocked.calls[0].request.url


def test_geocode_label_skips_missing_parts(mocked):
    mocked.add(responses.GET, GEOCODE_URL, json={"results": [{"name": "Nowhere", "latitude": 1, "longitude": 2}]})
    assert geocode("Nowhere")["name"] == "Nowhere"


@pytest.mark.parametrize("body", [{}, {"results": []}, {"results": None}])
def test_unknown_city_is_friendly(mocked, body):
    mocked.add(responses.GET, GEOCODE_URL, json=body)
    with pytest.raises(WeatherError, match="couldn't find a place called 'Zzyzx'"):
        geocode("Zzyzx")


def test_imperial_params():
    p = build_forecast_params(42.3, -83.0, "imperial")
    assert (p["latitude"], p["longitude"]) == (42.3, -83.0)
    assert (p["temperature_unit"], p["wind_speed_unit"], p["precipitation_unit"]) == ("fahrenheit", "mph", "inch")
    assert p["timezone"] == "auto"
    assert "temperature_2m_max" in p["daily"]


def test_metric_params():
    p = build_forecast_params(1, 2, "metric")
    assert (p["temperature_unit"], p["wind_speed_unit"], p["precipitation_unit"]) == ("celsius", "kmh", "mm")


def test_fetch_forecast_sends_params(mocked):
    mocked.add(responses.GET, FORECAST_URL, json={"daily": {"time": []}})
    fetch_forecast(10.5, 20.5, "metric")
    url = mocked.calls[0].request.url
    assert "latitude=10.5" in url and "temperature_unit=celsius" in url


def test_timeout_is_handled(mocked):
    mocked.add(responses.GET, GEOCODE_URL, body=requests.exceptions.Timeout())
    with pytest.raises(WeatherError, match="timed out"):
        geocode("Detroit")


def test_connection_error_is_handled(mocked):
    mocked.add(responses.GET, FORECAST_URL, body=requests.exceptions.ConnectionError())
    with pytest.raises(WeatherError, match="Could not reach"):
        fetch_forecast(1, 2)


@pytest.mark.parametrize("status", [500, 502, 503])
def test_server_errors_are_handled(mocked, status):
    mocked.add(responses.GET, FORECAST_URL, status=status)
    with pytest.raises(WeatherError, match="returned an error"):
        fetch_forecast(1, 2)


def test_invalid_json_is_handled(mocked):
    mocked.add(responses.GET, GEOCODE_URL, body="<html>oops</html>")
    with pytest.raises(WeatherError, match="unreadable"):
        geocode("Detroit")


def test_daily_rows_reshapes_columns():
    data = {"daily": {"time": ["2026-11-05", "2026-11-06"], "weather_code": [0, 3]}}
    assert daily_rows(data) == [{"time": "2026-11-05", "weather_code": 0},
                                {"time": "2026-11-06", "weather_code": 3}]
    assert daily_rows({}) == []
