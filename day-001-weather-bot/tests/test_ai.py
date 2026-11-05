import json

import pytest
import requests
import responses

import bot
from ai import API_URL, DEFAULT_MODEL, build_prompt, ask_claude

CLAUDE_REPLY = {"content": [{"type": "text", "text": "Bring a light jacket. No umbrella needed."}]}


def test_fallback_when_no_api_key(forecast, mocked, capsys):
    assert bot.main(["jacket in Detroit tomorrow"]) == 0
    out = capsys.readouterr().out
    assert "📍 Detroit, Michigan, US" in out
    assert not any(c.request.url == API_URL for c in mocked.calls)


def test_blank_api_key_counts_as_unset(forecast, mocked, monkeypatch, capsys):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")
    assert bot.main(["jacket in Detroit tomorrow"]) == 0
    assert "📍" in capsys.readouterr().out
    assert not any(c.request.url == API_URL for c in mocked.calls)


def test_ai_mode_used_when_key_set(forecast, mocked, monkeypatch, capsys):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    mocked.add(responses.POST, API_URL, json=CLAUDE_REPLY)
    assert bot.main(["Do I need a jacket in Detroit tomorrow?"]) == 0
    assert capsys.readouterr().out.strip() == "Bring a light jacket. No umbrella needed."
    call = [c for c in mocked.calls if c.request.url == API_URL][0]
    assert call.request.headers["x-api-key"] == "sk-test"
    assert json.loads(call.request.body)["model"] == DEFAULT_MODEL


def test_no_ai_flag_skips_claude_even_with_key(forecast, mocked, monkeypatch, capsys):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert bot.main(["jacket in Detroit tomorrow", "--no-ai"]) == 0
    assert "📍" in capsys.readouterr().out
    assert not any(c.request.url == API_URL for c in mocked.calls)


def test_prompt_contains_question_and_forecast(forecast, mocked, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    mocked.add(responses.POST, API_URL, json=CLAUDE_REPLY)
    question = "Do I need a jacket in Detroit tomorrow?"
    bot.main([question, "--units", "metric"])
    call = [c for c in mocked.calls if c.request.url == API_URL][0]
    content = json.loads(call.request.body)["messages"][0]["content"]
    assert question in content
    assert "Detroit, Michigan, US" in content
    assert "Units: metric" in content
    assert '"temperature_2m_max": 61.0' in content  # tomorrow's raw row, from make_rows


def test_build_prompt_is_pure():
    rows = [{"time": "2026-11-05", "temperature_2m_max": 50}]
    prompt = build_prompt("q?", "Place", rows, "imperial")
    assert prompt == 'Question: q?\nPlace: Place\nUnits: imperial\nForecast (JSON): ' + json.dumps(rows)


def test_model_override(mocked, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_MODEL", "custom-model")
    mocked.add(responses.POST, API_URL, json=CLAUDE_REPLY)
    ask_claude("q", "p", [], "imperial", "k")
    assert json.loads(mocked.calls[0].request.body)["model"] == "custom-model"


@pytest.mark.parametrize("failure", [
    {"status": 500},
    {"status": 401, "json": {"error": "bad key"}},
    {"body": requests.exceptions.ConnectionError()},
    {"body": requests.exceptions.Timeout()},
])
def test_claude_failure_falls_back_to_plain_forecast(forecast, mocked, monkeypatch, capsys, failure):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    mocked.add(responses.POST, API_URL, **failure)
    assert bot.main(["jacket in Detroit tomorrow"]) == 0
    captured = capsys.readouterr()
    assert "📍 Detroit, Michigan, US" in captured.out
    assert "AI answer unavailable" in captured.err
