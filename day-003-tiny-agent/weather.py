"""get_weather tool: Open-Meteo geocoding plus current conditions and the next 24 hours."""
import requests

from errors import ToolError

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 10

# WMO weather interpretation codes, grouped to keep the table short.
WEATHER_CODES = {
    0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
}

SCHEMA = {
    "name": "get_weather",
    "description": (
        "Get the current weather and the forecast for the next 24 hours for a city, using Open-Meteo. "
        "Returns temperature, conditions, wind and the chance of rain, including a summary of tonight."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "city": {"type": "string", "description": "City name, e.g. 'Detroit' or 'Paris'."},
            "units": {
                "type": "string",
                "enum": ["imperial", "metric"],
                "description": "imperial = Fahrenheit and mph (default), metric = Celsius and km/h.",
            },
        },
        "required": ["city"],
    },
}


def _get_json(url, params):
    try:
        resp = requests.get(url, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:
        raise ToolError(f"Could not reach Open-Meteo: {exc}", retryable=True) from None
    except ValueError:
        raise ToolError("Open-Meteo returned an unreadable response.", retryable=True) from None


def geocode(city):
    """Look a city up by name. Raises ToolError for an unknown place."""
    data = _get_json(GEOCODE_URL, {"name": city, "count": 1, "language": "en", "format": "json"})
    results = data.get("results") or []
    if not results:
        raise ToolError(f"No location found for '{city}'. Check the spelling or try a bigger nearby city.")
    place = results[0]
    label = ", ".join(p for p in (place.get("name"), place.get("admin1"), place.get("country")) if p)
    return {"lat": place["latitude"], "lon": place["longitude"], "label": label}


def describe(code):
    return WEATHER_CODES.get(code, f"weather code {code}")


def next_24_hours(hourly, now_iso):
    """Rows for the 24 hours starting at the current hour. Times are ISO strings, so they sort as text."""
    start = now_iso[:13] + ":00"
    rows = []
    for i, t in enumerate(hourly["time"]):
        if t >= start and len(rows) < 24:
            rows.append({
                "time": t,
                "temp": hourly["temperature_2m"][i],
                "rain_chance_pct": hourly["precipitation_probability"][i],
                "conditions": describe(hourly["weather_code"][i]),
            })
    return rows


def get_weather(city, units="imperial"):
    """Current weather plus a compact next-24h outlook for `city`."""
    if not isinstance(city, str) or not city.strip():
        raise ToolError("Provide a city name.")
    if units not in ("imperial", "metric"):
        raise ToolError("units must be 'imperial' or 'metric'.")
    imperial = units == "imperial"
    loc = geocode(city.strip())
    data = _get_json(FORECAST_URL, {
        "latitude": loc["lat"],
        "longitude": loc["lon"],
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
        "hourly": "temperature_2m,precipitation_probability,weather_code",
        "forecast_days": 2,
        "timezone": "auto",
        "temperature_unit": "fahrenheit" if imperial else "celsius",
        "wind_speed_unit": "mph" if imperial else "kmh",
    })
    try:
        cur = data["current"]
        rows = next_24_hours(data["hourly"], cur["time"])
        deg, speed = ("F", "mph") if imperial else ("C", "km/h")
        result = {
            "location": loc["label"],
            "units": units,
            "current": {
                "time": cur["time"],
                "temp": f"{cur['temperature_2m']}{deg}",
                "feels_like": f"{cur['apparent_temperature']}{deg}",
                "conditions": describe(cur["weather_code"]),
                "wind": f"{cur['wind_speed_10m']} {speed}",
            },
        }
    except (KeyError, TypeError, IndexError):
        raise ToolError("Open-Meteo response was missing expected fields.") from None
    if not rows:
        raise ToolError("Open-Meteo returned no hourly forecast.")
    temps = [r["temp"] for r in rows if r["temp"] is not None]
    chances = [r["rain_chance_pct"] or 0 for r in rows]
    result["next_24h"] = {
        "temp_range": f"{min(temps)}{deg} to {max(temps)}{deg}" if temps else "unknown",
        "max_rain_chance_pct": max(chances),
        "rainy_hours": sum(1 for c in chances if c >= 50),
        # Every third hour keeps the result small enough to read at a glance.
        "every_3h": rows[::3],
    }
    return result
