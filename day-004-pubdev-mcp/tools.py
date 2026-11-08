"""Tool logic: turns pub.dev API data into compact results.

Every public tool takes a PubDevClient first and returns a plain dict. Expected
failures (unknown package, timeout, 5xx) come back as {"error": "..."} instead
of raising, so Claude can read the message and carry on.
"""
import asyncio
import functools
import re
from datetime import datetime, timezone
from typing import Any

from client import PubDevClient, PubDevError

MAX_SEARCH_LIMIT = 25
SEARCH_PAGES_MAX = 3
DESCRIPTION_MAX = 200


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def safe(func):
    """Turn PubDevError into an {"error": message} result."""

    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except PubDevError as exc:
            return {"error": str(exc)}

    return wrapper


# --- small helpers --------------------------------------------------------


def _tidy(text: str | None) -> str | None:
    if not text:
        return None
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > DESCRIPTION_MAX:
        text = text[: DESCRIPTION_MAX - 3].rstrip() + "..."
    return text or None


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _days_since(moment: datetime | None) -> int | None:
    return None if moment is None else max((utcnow() - moment).days, 0)


def _tag_values(tags: list[str], prefix: str) -> list[str]:
    return sorted(t[len(prefix):] for t in tags if t.startswith(prefix))


def _flags(tags: list[str], package: dict[str, Any] | None = None) -> dict[str, bool]:
    tagset = set(tags)
    discontinued = "is:discontinued" in tagset or bool((package or {}).get("isDiscontinued"))
    return {
        "null_safe": "is:null-safe" in tagset,
        "dart3_compatible": "is:dart3-compatible" in tagset,
        "wasm_ready": "is:wasm-ready" in tagset,
        "flutter_favorite": "is:flutter-favorite" in tagset,
        "discontinued": discontinued,
    }


def _points(score: dict[str, Any]) -> str:
    return f"{score.get('grantedPoints', 0)}/{score.get('maxPoints', 0)}"


def _publisher(tags: list[str]) -> str | None:
    found = _tag_values(tags, "publisher:")
    return found[0] if found else None


async def _load(client: PubDevClient, name: str) -> tuple[dict, dict]:
    package, score = await asyncio.gather(client.package(name), client.score(name))
    return package, score


async def _search_row(client: PubDevClient, name: str) -> dict[str, Any]:
    try:
        package, score = await _load(client, name)
    except PubDevError as exc:
        return {"name": name, "error": str(exc)}
    latest = package.get("latest", {})
    return {
        "name": name,
        "description": _tidy(latest.get("pubspec", {}).get("description")),
        "latest_version": latest.get("version"),
        "likes": score.get("likeCount"),
        "pub_points": _points(score),
        "downloads_30d": score.get("downloadCount30Days"),
    }


# --- tools ----------------------------------------------------------------


@safe
async def search_packages(client: PubDevClient, query: str, limit: int = 10) -> dict[str, Any]:
    query = (query or "").strip()
    if not query:
        return {"error": "Give a search query, for example 'state management'."}
    limit = max(1, min(int(limit), MAX_SEARCH_LIMIT))

    names: list[str] = []
    for page in range(1, SEARCH_PAGES_MAX + 1):
        data = await client.search(query, page)
        names += [p["package"] for p in data.get("packages", []) if p.get("package")]
        if len(names) >= limit or not data.get("next"):
            break
    names = list(dict.fromkeys(names))[:limit]
    if not names:
        return {"query": query, "count": 0, "results": [], "note": "No packages matched."}

    results = await asyncio.gather(*(_search_row(client, n) for n in names))
    return {"query": query, "count": len(results), "results": list(results)}


@safe
async def package_info(client: PubDevClient, name: str) -> dict[str, Any]:
    package, score = await _load(client, name)
    latest = package.get("latest", {})
    pubspec = latest.get("pubspec", {})
    tags = score.get("tags", [])
    published = _parse_time(latest.get("published"))
    info: dict[str, Any] = {
        "name": package.get("name"),
        "latest_version": latest.get("version"),
        "description": _tidy(pubspec.get("description")),
        "publisher": _publisher(tags),
        "last_published": published.date().isoformat() if published else None,
        "days_since_publish": _days_since(published),
        "sdk_constraints": pubspec.get("environment", {}),
        "sdks": _tag_values(tags, "sdk:"),
        "platforms": _tag_values(tags, "platform:"),
        "repository": pubspec.get("repository"),
        "homepage": pubspec.get("homepage"),
        "issue_tracker": pubspec.get("issue_tracker"),
        "topics": pubspec.get("topics", []),
        "discontinued": _flags(tags, package)["discontinued"],
        "url": f"https://pub.dev/packages/{package.get('name')}",
    }
    if package.get("replacedBy"):
        info["replaced_by"] = package["replacedBy"]
    return info


async def _breakdown(client: PubDevClient, name: str) -> list[dict[str, Any]] | None:
    """Pub points per area. Best effort: the score itself does not need it."""
    try:
        metrics = await client.metrics(name)
    except PubDevError:
        return None
    report = (metrics.get("scorecard", {}).get("panaReport") or {}).get("report") or {}
    sections = report.get("sections") or []
    return [
        {
            "area": s.get("title"),
            "points": f"{s.get('grantedPoints', 0)}/{s.get('maxPoints', 0)}",
            "status": s.get("status"),
        }
        for s in sections
    ] or None


@safe
async def package_score(client: PubDevClient, name: str) -> dict[str, Any]:
    package, score = await _load(client, name)
    tags = score.get("tags", [])
    result: dict[str, Any] = {
        "name": package.get("name"),
        "pub_points": _points(score),
        "likes": score.get("likeCount"),
        "downloads_30d": score.get("downloadCount30Days"),
        "flags": _flags(tags, package),
        "platforms": _tag_values(tags, "platform:"),
        "licenses": [t for t in _tag_values(tags, "license:") if t not in ("fsf-libre", "osi-approved")],
    }
    breakdown = await _breakdown(client, package.get("name") or name)
    if breakdown:
        result["pub_points_breakdown"] = breakdown
    if package.get("replacedBy"):
        result["replaced_by"] = package["replacedBy"]
    return result
