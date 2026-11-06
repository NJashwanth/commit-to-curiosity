"""Build the prompt, ask Claude, and fall back to printing the raw chunks."""
import os
import re
from dataclasses import dataclass

DEFAULT_MODEL = "claude-haiku-5-5"
MAX_TOKENS = 1024
FALLBACK_PREVIEW_LINES = 14

SYSTEM_PROMPT = (
    "You answer questions about a code repository. You are given numbered excerpts retrieved "
    "from it, each labelled with its file path and line range. Answer ONLY from those excerpts. "
    "If they do not contain the answer, say so plainly instead of guessing. Cite every claim "
    "with the path and line range of the excerpt it came from, written exactly as "
    "`path:start-end` (for example `src/app.py:10-42`). Be concise and concrete."
)


@dataclass
class Answer:
    text: str
    hits: list
    mode: str          # "claude" or "fallback"
    note: str = ""     # why we fell back, if we did


def build_prompt(question, hits):
    """The user message: every retrieved chunk with its path:range label, then the question."""
    parts = ["Context excerpts from the repository:\n"]
    for i, hit in enumerate(hits, 1):
        parts.append(f"--- Excerpt {i}: {hit.ref} ---\n{hit.text}\n")
    parts.append(f"Question: {question}")
    return "\n".join(parts)


def ask_claude(question, hits, api_key, client=None):
    """One Claude call. Raises on any API error; `answer` decides how to recover."""
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key, timeout=60.0)
    response = client.messages.create(
        model=os.getenv("ANTHROPIC_MODEL") or DEFAULT_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_prompt(question, hits)}],
    )
    text = "".join(getattr(b, "text", "") for b in response.content).strip()
    if not text:
        raise ValueError("Claude returned an empty answer")
    return text


def fallback_text(hits):
    """No LLM: show the best chunks themselves, with path, line range and score."""
    if not hits:
        return "No matching code found."
    blocks = []
    for i, hit in enumerate(hits, 1):
        lines = hit.text.splitlines()
        shown = "\n".join(f"    {line}" for line in lines[:FALLBACK_PREVIEW_LINES])
        if len(lines) > FALLBACK_PREVIEW_LINES:
            shown += f"\n    ... ({len(lines) - FALLBACK_PREVIEW_LINES} more lines)"
        blocks.append(f"[{i}] {hit.ref}  (score {hit.score:.3f})\n{shown}")
    return "\n\n".join(blocks)


def answer(question, hits, api_key=None, client=None):
    """Claude's answer when a key is set and the call works; otherwise the raw top chunks."""
    api_key = (api_key or "").strip()
    if not hits:
        return Answer(fallback_text(hits), hits, "fallback")
    if not api_key and client is None:
        return Answer(fallback_text(hits), hits, "fallback",
                      "No ANTHROPIC_API_KEY set, showing the top matching chunks.")
    try:
        return Answer(ask_claude(question, hits, api_key, client), hits, "claude")
    except Exception as exc:  # any API, network or auth problem: still be useful
        note = f"Claude request failed ({type(exc).__name__}), showing the top matching chunks."
        return Answer(fallback_text(hits), hits, "fallback", note)


def cited_refs(text, hits):
    """Refs of the retrieved chunks that the answer text mentions (path:start-end)."""
    return {h.ref for h in hits if re.search(re.escape(h.ref) + r"(?!\d)", text)}


def format_citations(ans):
    """The 'Sources' block shown under every answer."""
    if not ans.hits:
        return "Sources: none"
    cited = cited_refs(ans.text, ans.hits) if ans.mode == "claude" else set()
    lines = ["Sources:"]
    for hit in ans.hits:
        mark = "  (cited)" if hit.ref in cited else ""
        lines.append(f"  {hit.ref}  score {hit.score:.3f}{mark}")
    return "\n".join(lines)


def format_answer(ans):
    head = f"Note: {ans.note}\n\n" if ans.note else ""
    return f"{head}{ans.text}\n\n{format_citations(ans)}"
