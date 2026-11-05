from datetime import date, timedelta

import pytest
import responses

import bot
from weather import FORECAST_URL, GEOCODE_URL


def forecast_call(mocked):
    return [c for c in mocked.calls if c.request.url.startswith(FORECAST_URL)][0]


def test_units_default_is_imperial(forecast, mocked, capsys):
    assert bot.main(["weather in Detroit"]) == 0
    assert "temperature_unit=fahrenheit" in forecast_call(mocked).request.url
    assert "°F" in capsys.readouterr().out


def test_units_metric_flag(forecast, mocked, capsys):
    assert bot.main(["weather in Detroit", "--units", "metric"]) == 0
    assert "temperature_unit=celsius" in forecast_call(mocked).request.url
    out = capsys.readouterr().out
    assert "°C" in out and "km/h" in out


def test_invalid_units_shows_helpful_error(capsys):
    with pytest.raises(SystemExit) as exc:
        bot.main(["weather in Detroit", "--units", "kelvin"])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert "invalid choice" in err and "metric" in err and "imperial" in err


def test_end_to_end_prints_forecast_and_exits_zero(forecast, capsys):
    assert bot.main(["Do I need a jacket in Detroit tomorrow?"]) == 0
    out = capsys.readouterr().out
    tomorrow = (date.today() + timedelta(days=1)).strftime("%a %b %d")
    assert "📍 Detroit, Michigan, US" in out
    assert tomorrow in out
    assert "🌦️" in out and "Light rain" in out  # code 61 on day index 1


def test_empty_question_exits_2(capsys):
    assert bot.main([]) == 2
    assert "Ask me something" in capsys.readouterr().err


def test_no_city_exits_2(capsys):
    assert bot.main(["Is it nice out"]) == 2
    assert "which city" in capsys.readouterr().err


def test_unknown_city_exits_1(mocked, capsys):
    mocked.add(responses.GET, GEOCODE_URL, json={"results": []})
    assert bot.main(["weather in Zzyzx"]) == 1
    assert "couldn't find a place" in capsys.readouterr().err


def test_network_failure_exits_1(mocked, capsys):
    import requests
    mocked.add(responses.GET, GEOCODE_URL, body=requests.exceptions.ConnectionError())
    assert bot.main(["weather in Detroit"]) == 1
    assert "Could not reach" in capsys.readouterr().err
