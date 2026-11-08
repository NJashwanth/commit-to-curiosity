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

from client import PubDevClient, PubDevError, normalize_publisher

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


# --- compare ----------------------------------------------------------------

MIN_COMPARE = 2
MAX_COMPARE = 5
STALE_DAYS = 365
LOW_SCORE_RATIO = 0.5
LOW_SCORE_DAYS = 180


def health_verdict(
    discontinued: bool, days_since_publish: int | None, granted: int, maximum: int
) -> tuple[str, str]:
    """Return (verdict, reason): discontinued, stale or active.

    discontinued: pub.dev marks the package discontinued.
    stale: last publish over a year ago, or over 6 months ago with under half the pub points.
    active: everything else.
    """
    if discontinued:
        return "discontinued", "marked discontinued on pub.dev"
    if days_since_publish is None:
        return "stale", "no publish date available"
    if days_since_publish > STALE_DAYS:
        return "stale", f"last published {days_since_publish} days ago (over a year)"
    ratio = granted / maximum if maximum else 0
    if days_since_publish > LOW_SCORE_DAYS and ratio < LOW_SCORE_RATIO:
        return "stale", f"last published {days_since_publish} days ago with only {granted}/{maximum} pub points"
    return "active", f"published {days_since_publish} days ago, {granted}/{maximum} pub points"


async def _compare_row(client: PubDevClient, name: str) -> dict[str, Any]:
    try:
        package, score = await _load(client, name)
    except PubDevError as exc:
        return {"name": name, "error": str(exc)}
    latest = package.get("latest", {})
    tags = score.get("tags", [])
    flags = _flags(tags, package)
    published = _parse_time(latest.get("published"))
    days = _days_since(published)
    verdict, reason = health_verdict(
        flags["discontinued"], days, score.get("grantedPoints", 0), score.get("maxPoints", 0)
    )
    row = {
        "name": package.get("name", name),
        "latest_version": latest.get("version"),
        "last_published": published.date().isoformat() if published else None,
        "days_since_publish": days,
        "pub_points": _points(score),
        "pub_points_granted": score.get("grantedPoints", 0),
        "likes": score.get("likeCount"),
        "downloads_30d": score.get("downloadCount30Days"),
        "null_safe": flags["null_safe"],
        "dart3_compatible": flags["dart3_compatible"],
        "platforms": _tag_values(tags, "platform:"),
        "verdict": verdict,
        "verdict_reason": reason,
    }
    if package.get("replacedBy"):
        row["replaced_by"] = package["replacedBy"]
    return row


def _leader(rows: list[dict[str, Any]], key: str) -> str | None:
    scored = [r for r in rows if isinstance(r.get(key), (int, float)) and r.get("verdict") != "discontinued"]
    return max(scored, key=lambda r: r[key])["name"] if scored else None


@safe
async def compare_packages(client: PubDevClient, names: list[str]) -> dict[str, Any]:
    if not isinstance(names, (list, tuple)):
        return {"error": "names must be a list of 2 to 5 package names."}
    unique = list(dict.fromkeys(str(n).strip().lower() for n in names if str(n).strip()))
    if len(unique) < MIN_COMPARE:
        return {"error": f"Give at least {MIN_COMPARE} different package names to compare."}
    if len(unique) > MAX_COMPARE:
        return {"error": f"Compare at most {MAX_COMPARE} packages at a time (got {len(unique)})."}

    rows = list(await asyncio.gather(*(_compare_row(client, n) for n in unique)))
    ok = [r for r in rows if "error" not in r]
    leaders = {
        "pub_points": _leader(ok, "pub_points_granted"),
        "likes": _leader(ok, "likes"),
        "downloads_30d": _leader(ok, "downloads_30d"),
    }
    for row in ok:
        del row["pub_points_granted"]
    return {"packages": rows, "leaders": leaders, "verdict_rules": (
        f"discontinued = flagged on pub.dev; stale = last publish over {STALE_DAYS} days ago, or over "
        f"{LOW_SCORE_DAYS} days with under {int(LOW_SCORE_RATIO * 100)}% of pub points; otherwise active"
    )}


# --- publisher ----------------------------------------------------------------

PUBLISHER_PAGES_MAX = 4
PUBLISHER_SHOW_MAX = 30


async def _publisher_row(client: PubDevClient, name: str) -> dict[str, Any]:
    try:
        package = await client.package(name)
    except PubDevError as exc:
        return {"name": name, "error": str(exc)}
    latest = package.get("latest", {})
    published = _parse_time(latest.get("published"))
    return {
        "name": name,
        "latest_version": latest.get("version"),
        "description": _tidy(latest.get("pubspec", {}).get("description")),
        "last_published": published.date().isoformat() if published else None,
        "discontinued": bool(package.get("isDiscontinued")),
    }


@safe
async def publisher_packages(client: PubDevClient, publisher: str) -> dict[str, Any]:
    publisher = normalize_publisher(publisher)
    meta = await client.publisher(publisher)

    names: list[str] = []
    for page in range(1, PUBLISHER_PAGES_MAX + 1):
        data = await client.search(f"publisher:{publisher}", page)
        names += [p["package"] for p in data.get("packages", []) if p.get("package")]
        if not data.get("next"):
            break
    names = list(dict.fromkeys(names))
    shown = names[:PUBLISHER_SHOW_MAX]

    result: dict[str, Any] = {
        "publisher": publisher,
        "website": meta.get("websiteUrl"),
        "package_count": len(names),
        "packages": list(await asyncio.gather(*(_publisher_row(client, n) for n in shown))),
    }
    if len(names) > len(shown):
        result["note"] = f"Showing the first {len(shown)} of {len(names)} packages."
    if not names:
        result["note"] = "This publisher has no public packages."
    return result
