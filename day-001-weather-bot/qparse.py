"""Pull a city and a time frame out of a natural-language question."""
import re
from datetime import timedelta


class QuestionError(ValueError):
    """The question was empty or we could not find a city in it."""


WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
                "eight": 8, "nine": 9, "ten": 10}
N = r"(\d{1,2}|" + "|".join(NUMBER_WORDS) + r")"
WEEKDAY_RE = r"\b(" + "|".join(WEEKDAYS) + r")\b"

# Checked in order; the first match wins.
TIMEFRAMES = [
    ("week", r"\b(next\s+7\s+days|next\s+seven\s+days|7[-\s]?day|seven[-\s]?day|this\s+week|next\s+week|week(?:ly)?|rest\s+of\s+the\s+week)\b"),
    ("weekend", r"\bweekends?\b"),
    ("in 2 days", r"\bday\s+after\s+tomorrow\b"),
    ("in {n} days", rf"\bin\s+{N}\s+days?\b|\b{N}\s+days?\s+from\s+(?:now|today)\b"),
    ("next {n} days", rf"\b(?:next|coming|upcoming)\s+{N}\s+days\b|\b{N}[-\s]days?\s+(?:forecast|outlook)\b"),
    ("{weekday}", WEEKDAY_RE),
    ("tomorrow", r"\b(tomorrow|tmrw)\b"),
    ("today", r"\b(today|tonight|right\s+now|now|this\s+(?:morning|afternoon|evening))\b"),
]

# Words that suggest the question names a time we did not understand.
TIME_HINT_RE = re.compile(
    r"\b(days|weeks?|months?|fortnight|later|soon|upcoming|\d+(?:st|nd|rd|th)|"
    r"jan(?:uary)?|feb(?:ruary)?|march|april|june|july|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|"
    r"nov(?:ember)?|dec(?:ember)?)\b",
    re.IGNORECASE,
)

# City follows a preposition and runs until a time word, another preposition, or punctuation.
STOP = (r"tomorrow|tmrw|today|tonight|now|this|next|over|on|during|for|in|at|near|around|the|"
        r"weekend|week|please|" + "|".join(WEEKDAYS) + r"|\?|\.|,|!|$")
CITY_RE = re.compile(
    rf"\b(?:in|for|at|near|around)\s+([A-Za-z][A-Za-z .'\-]*?)(?=\s+(?:{STOP})\b|\s*[?,!]|\.\s*$|\s*$)",
    re.IGNORECASE,
)
NOISE = {"the", "a", "an", "it", "there", "my", "your", "this", "that", "me", "us", "case", "general",
         "the morning", "the afternoon", "the evening", "the rain", "advance", "night", "noon", "lunch"}


def _number(text):
    return int(text) if text.isdigit() else NUMBER_WORDS[text]


def _match_timeframe(question):
    """Return the time frame named in the question, or None if there isn't one we understand."""
    q = question.lower()
    for name, pattern in TIMEFRAMES:
        m = re.search(pattern, q)
        if not m:
            continue
        found = next((g for g in m.groups() if g), None)
        if "{n}" in name:
            n = _number(found)
            if name.startswith("next") and n == 0:
                continue
            return name.format(n=n)
        if name == "{weekday}":
            return found
        return name
    return None


def parse_timeframe(question):
    """One of: today, tomorrow, weekend, week, a weekday name, 'in N days', 'next N days'."""
    return _match_timeframe(question) or "today"


def timeframe_was_guessed(question):
    """True when the question seems to mention a time we couldn't parse, so 'today' is a guess."""
    return _match_timeframe(question) is None and bool(TIME_HINT_RE.search(question))


def timeframe_dates(timeframe, today):
    """The calendar dates a time frame covers, starting from `today`."""
    if timeframe == "today":
        return [today]
    if timeframe == "tomorrow":
        return [today + timedelta(days=1)]
    if timeframe == "weekend":
        if today.weekday() == 6:  # Sunday: only Sunday is left
            return [today]
        sat = today + timedelta(days=(5 - today.weekday()) % 7)
        return [sat, sat + timedelta(days=1)]
    if timeframe == "week":
        return [today + timedelta(days=i) for i in range(7)]
    if timeframe in WEEKDAYS:
        return [today + timedelta(days=(WEEKDAYS.index(timeframe) - today.weekday()) % 7)]
    m = re.fullmatch(r"in (\d+) days", timeframe)
    if m:
        return [today + timedelta(days=int(m.group(1)))]
    m = re.fullmatch(r"next (\d+) days", timeframe)
    if m:
        return [today + timedelta(days=i) for i in range(int(m.group(1)))]
    raise ValueError(f"unknown time frame: {timeframe!r}")


def _is_time_phrase(text):
    """'tomorrow', 'a few days', 'two weeks' and the like are never the place."""
    return _match_timeframe(text) is not None or bool(
        re.search(r"\b(days|weeks?|months?|fortnight)\b", text, re.IGNORECASE))


def parse_city(question):
    candidates = []
    for m in CITY_RE.finditer(question):
        city = m.group(1).strip(" .'-")
        if city.lower() not in NOISE and len(city) > 1 and not _is_time_phrase(city):
            candidates.append(city)
    if candidates:
        # The last match is usually the place ("Weekend forecast for Austin").
        return candidates[-1]
    return _city_before_keyword(question)


FILLER = {"what", "whats", "what's", "is", "the", "how", "hows", "how's", "whats", "s", "will", "be",
          "do", "i", "need", "a", "an", "and", "or", "of", "it", "like", "its", "it's"}


def _city_before_keyword(question):
    """Handle 'Detroit weather' / 'Austin forecast tomorrow' (no preposition)."""
    m = re.search(r"^(.*?)\b(?:weather|forecast)\b", question, re.IGNORECASE)
    if not m:
        return None
    text = m.group(1)
    for _, pattern in TIMEFRAMES:
        text = re.sub(pattern, " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[?.,!]", " ", text)
    words = [w for w in text.split() if w.lower() not in FILLER]
    return " ".join(words) or None


def parse_question(question):
    """Return (city, timeframe). Raises QuestionError if the question is empty or has no city."""
    if not question or not question.strip():
        raise QuestionError("Ask me something like: \"Do I need a jacket in Detroit tomorrow?\"")
    city = parse_city(question)
    if not city:
        raise QuestionError("I couldn't tell which city you mean. Try something like: "
                            "\"Do I need a jacket in Detroit tomorrow?\"")
    return city, parse_timeframe(question)
