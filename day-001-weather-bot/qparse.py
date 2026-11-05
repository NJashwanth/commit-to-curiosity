"""Pull a city and a time frame out of a natural-language question."""
import re

TIMEFRAMES = [
    ("week", r"\b(next\s+7\s+days|next\s+seven\s+days|7[-\s]?day|seven[-\s]?day|this\s+week|next\s+week|week(?:ly)?|rest\s+of\s+the\s+week)\b"),
    ("weekend", r"\b(weekends?|saturday|sunday)\b"),
    ("tomorrow", r"\b(tomorrow|tmrw)\b"),
    ("today", r"\b(today|tonight|right\s+now|now|this\s+(?:morning|afternoon|evening))\b"),
]

# City follows "in/for/at/near/around" and runs until a time word or punctuation.
STOP = (r"tomorrow|tmrw|today|tonight|now|this|next|over|on|during|for|this\s+weekend|weekend|"
        r"saturday|sunday|week|please|\?|\.|,|!|$")
CITY_RE = re.compile(
    rf"\b(?:in|for|at|near|around)\s+([A-Za-z][A-Za-z .'\-]*?)(?=\s+(?:{STOP})\b|\s*[?,!]|\.\s*$|\s*$)",
    re.IGNORECASE,
)
NOISE = {"the", "a", "an", "it", "there", "my", "your", "this", "that", "me", "us", "case", "general",
         "the morning", "the afternoon", "the evening", "the rain", "advance"}


def parse_timeframe(question):
    q = question.lower()
    for name, pattern in TIMEFRAMES:
        if re.search(pattern, q):
            return name
    return "today"


def parse_city(question):
    candidates = []
    for m in CITY_RE.finditer(question):
        city = m.group(1).strip(" .'-")
        if city.lower() not in NOISE and len(city) > 1:
            candidates.append(city)
    if not candidates:
        return None
    # The last match is usually the place ("Weekend forecast for Austin").
    return candidates[-1]


def parse_question(question):
    return parse_city(question), parse_timeframe(question)
