"""Open-Meteo helpers: geocoding, forecast fetching and plain-text formatting."""
from datetime import date, timedelta

import requests

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 10


class WeatherError(Exception):
    """A problem we can explain to the user in one line."""


# WMO weather codes -> (emoji, description)
WMO = {
    0: ("☀️", "Clear sky"), 1: ("🌤️", "Mostly clear"), 2: ("⛅", "Partly cloudy"),
    3: ("☁️", "Overcast"), 45: ("🌫️", "Fog"), 48: ("🌫️", "Rime fog"),
    51: ("🌦️", "Light drizzle"), 53: ("🌦️", "Drizzle"), 55: ("🌧️", "Heavy drizzle"),
    56: ("🌧️", "Freezing drizzle"), 57: ("🌧️", "Freezing drizzle"),
    61: ("🌦️", "Light rain"), 63: ("🌧️", "Rain"), 65: ("🌧️", "Heavy rain"),
    66: ("🌧️", "Freezing rain"), 67: ("🌧️", "Freezing rain"),
    71: ("🌨️", "Light snow"), 73: ("❄️", "Snow"), 75: ("❄️", "Heavy snow"),
    77: ("🌨️", "Snow grains"), 80: ("🌦️", "Rain showers"), 81: ("🌧️", "Rain showers"),
    82: ("⛈️", "Violent showers"), 85: ("🌨️", "Snow showers"), 86: ("❄️", "Heavy snow showers"),
    95: ("⛈️", "Thunderstorm"), 96: ("⛈️", "Thunderstorm, hail"), 99: ("⛈️", "Severe thunderstorm"),
}


def describe(code):
    return WMO.get(code, ("🌡️", "Unknown"))


def _get(url, params):
    try:
        resp = requests.get(url, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.Timeout:
        raise WeatherError("The weather service timed out. Try again in a moment.")
    except requests.exceptions.ConnectionError:
        raise WeatherError("Could not reach the weather service. Check your network connection.")
    except requests.exceptions.RequestException as exc:
        raise WeatherError(f"The weather service returned an error: {exc}")
    except ValueError:
        raise WeatherError("The weather service sent back something unreadable.")


def geocode(city):
    data = _get(GEOCODE_URL, {"name": city, "count": 1, "language": "en", "format": "json"})
    results = data.get("results") or []
    if not results:
        raise WeatherError(f"I couldn't find a place called '{city}'. Check the spelling or add a country.")
    r = results[0]
    label = ", ".join(p for p in (r.get("name"), r.get("admin1"), r.get("country_code")) if p)
    return {"name": label, "lat": r["latitude"], "lon": r["longitude"]}


def fetch_forecast(lat, lon, units="imperial"):
    imperial = units == "imperial"
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": ",".join([
            "weather_code", "temperature_2m_max", "temperature_2m_min",
            "apparent_temperature_max", "precipitation_probability_max",
            "precipitation_sum", "wind_speed_10m_max", "sunrise", "sunset",
        ]),
        "hourly": "temperature_2m,precipitation_probability,weather_code",
        "temperature_unit": "fahrenheit" if imperial else "celsius",
        "wind_speed_unit": "mph" if imperial else "kmh",
        "precipitation_unit": "inch" if imperial else "mm",
        "timezone": "auto",
        "forecast_days": 8,
    }
    return _get(FORECAST_URL, params)


def daily_rows(data):
    """Turn Open-Meteo's column-oriented daily block into a list of dicts."""
    d = data.get("daily") or {}
    days = d.get("time") or []
    return [{k: v[i] for k, v in d.items()} for i in range(len(days))]


def select_days(rows, timeframe, today=None):
    """Pick the rows for a timeframe: today, tomorrow, weekend or week."""
    today = today or date.today()
    by_date = {r["time"]: r for r in rows}
    if timeframe == "today":
        wanted = [today]
    elif timeframe == "tomorrow":
        wanted = [today + timedelta(days=1)]
    elif timeframe == "weekend":
        if today.weekday() == 6:  # Sunday: only Sunday is left
            wanted = [today]
        else:
            sat = today + timedelta(days=(5 - today.weekday()) % 7)
            wanted = [sat, sat + timedelta(days=1)]
    else:  # week
        wanted = [today + timedelta(days=i) for i in range(7)]
    picked = [by_date[d.isoformat()] for d in wanted if d.isoformat() in by_date]
    if not picked:
        raise WeatherError("The forecast doesn't cover that time frame (I only see about a week ahead).")
    return picked


def format_forecast(place, rows, units="imperial"):
    t = "°F" if units == "imperial" else "°C"
    w = "mph" if units == "imperial" else "km/h"
    rain_unit = "in" if units == "imperial" else "mm"
    lines = [f"📍 {place}", ""]
    for r in rows:
        emoji, desc = describe(r.get("weather_code"))
        day = date.fromisoformat(r["time"]).strftime("%a %b %d")
        lines.append(
            f"{emoji}  {day}: {desc}, {r['temperature_2m_min']:.0f}{t} to {r['temperature_2m_max']:.0f}{t}"
            f" (feels up to {r['apparent_temperature_max']:.0f}{t})"
        )
        lines.append(
            f"     ☔ {r['precipitation_probability_max'] or 0}% chance ({r['precipitation_sum'] or 0:g} {rain_unit})"
            f"   💨 up to {r['wind_speed_10m_max']:.0f} {w}"
        )
    return "\n".join(lines)
