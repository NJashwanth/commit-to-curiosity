from datetime import date

import pytest

from qparse import (QuestionError, parse_city, parse_question, parse_timeframe, timeframe_dates,
                    timeframe_was_guessed)


@pytest.mark.parametrize("question,city", [
    ("Do I need a jacket in Detroit tomorrow?", "Detroit"),
    ("Weekend forecast for Austin", "Austin"),
    ("Detroit weather", "Detroit"),
    ("detroit weather tomorrow", "detroit"),
    ("What's the weather in Seattle?", "Seattle"),
    ("Is it raining near Boston today", "Boston"),
])
def test_city_from_varied_phrasing(question, city):
    assert parse_city(question) == city


@pytest.mark.parametrize("question,city", [
    ("Do I need a coat in New York tomorrow?", "New York"),
    ("Weekend forecast for San Francisco", "San Francisco"),
    ("San Francisco weather", "San Francisco"),
    ("Forecast for St. Louis this weekend", "St. Louis"),
    ("Will it rain in New York City next 7 days?", "New York City"),
])
def test_multi_word_cities(question, city):
    assert parse_city(question) == city


@pytest.mark.parametrize("question,frame", [
    ("weather in Detroit today", "today"),
    ("weather in Detroit tonight", "today"),
    ("weather in Detroit tomorrow", "tomorrow"),
    ("Weekend forecast for Austin", "weekend"),
    ("weather in Austin on Saturday", "saturday"),
    ("Will Boston be cold on Friday?", "friday"),
    ("rain in Austin next 3 days", "next 3 days"),
    ("rain in Austin over the next two days", "next 2 days"),
    ("3-day forecast for Austin", "next 3 days"),
    ("What should I wear in Tokyo in 3 days?", "in 3 days"),
    ("weather in Austin 4 days from now", "in 4 days"),
    ("rain in Boston the day after tomorrow?", "in 2 days"),
    ("weather in Austin this weekend", "weekend"),
    ("weather in Austin next 7 days", "week"),
    ("weather in Austin this week", "week"),
    ("weather in Austin", "today"),  # default
])
def test_timeframes(question, frame):
    assert parse_timeframe(question) == frame


@pytest.mark.parametrize("question,city", [
    ("Is it a good day for a picnic in Paris?", "Paris"),
    ("Jacket for hiking at Yosemite?", "Yosemite"),
    ("weather in Paris for tomorrow?", "Paris"),
    ("weather in Paris at night", "Paris"),
    ("Rain in Boston the day after tomorrow?", "Boston"),
    ("What should I wear in Tokyo in 3 days?", "Tokyo"),
    ("Will it rain in Seattle on Friday?", "Seattle"),
    ("Weather in The Hague tomorrow", "The Hague"),
    ("Weather in Austin in a few days", "Austin"),
    ("Weather in Austin in two weeks", "Austin"),
])
def test_city_not_swallowed_by_other_phrases(question, city):
    assert parse_city(question) == city


@pytest.mark.parametrize("question,guessed", [
    ("weather in Austin", False),  # no time mentioned: today is the honest default
    ("Is it a good day for a picnic in Paris?", False),
    ("weather in Austin tomorrow", False),
    ("weather in Austin in a few days", True),
    ("weather in Austin next month", True),
    ("weather in Austin on Dec 3rd", True),
])
def test_timeframe_was_guessed(question, guessed):
    assert timeframe_was_guessed(question) is guessed


THU = date(2026, 11, 5)


@pytest.mark.parametrize("frame,expected", [
    ("friday", ["2026-11-06"]),
    ("thursday", ["2026-11-05"]),  # the weekday is today
    ("wednesday", ["2026-11-11"]),  # already passed this week: next one
    ("in 3 days", ["2026-11-08"]),
    ("in 0 days", ["2026-11-05"]),
    ("next 3 days", ["2026-11-05", "2026-11-06", "2026-11-07"]),
])
def test_timeframe_dates(frame, expected):
    assert [d.isoformat() for d in timeframe_dates(frame, THU)] == expected


def test_next_zero_days_is_not_a_timeframe():
    assert parse_timeframe("weather in Austin next 0 days") == "today"


def test_unknown_timeframe_name_raises():
    with pytest.raises(ValueError, match="unknown time frame"):
        timeframe_dates("fortnight", THU)


def test_parse_question_returns_city_and_frame():
    assert parse_question("Do I need a jacket in Detroit tomorrow?") == ("Detroit", "tomorrow")


@pytest.mark.parametrize("question", ["", "   ", None])
def test_empty_question_raises(question):
    with pytest.raises(QuestionError, match="Ask me something"):
        parse_question(question)


@pytest.mark.parametrize("question", ["Is it nice out", "what should I wear", "weather"])
def test_question_without_city_raises(question):
    with pytest.raises(QuestionError, match="which city"):
        parse_question(question)
