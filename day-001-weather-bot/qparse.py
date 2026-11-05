"""Pull a city and a time frame out of a natural-language question."""
import re


class QuestionError(ValueError):
    """The question was empty or we could not find a city in it."""

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


def parse_city(question):
    candidates = []
    for m in CITY_RE.finditer(question):
        city = m.group(1).strip(" .'-")
        if city.lower() not in NOISE and len(city) > 1:
            candidates.append(city)
    if candidates:
        # The last match is usually the place ("Weekend forecast for Austin").
        return candidates[-1]
    return _city_before_keyword(question)


def parse_question(question):
    """Return (city, timeframe). Raises QuestionError if the question is empty or has no city."""
    if not question or not question.strip():
        raise QuestionError("Ask me something like: \"Do I need a jacket in Detroit tomorrow?\"")
    city = parse_city(question)
    if not city:
        raise QuestionError("I couldn't tell which city you mean. Try something like: "
                            "\"Do I need a jacket in Detroit tomorrow?\"")
    return city, parse_timeframe(question)
