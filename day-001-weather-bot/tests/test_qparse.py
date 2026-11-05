import pytest

from qparse import QuestionError, parse_city, parse_question, parse_timeframe


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
    ("weather in Austin on Saturday", "weekend"),
    ("weather in Austin next 7 days", "week"),
    ("weather in Austin this week", "week"),
    ("weather in Austin", "today"),  # default
])
def test_timeframes(question, frame):
    assert parse_timeframe(question) == frame


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
