from datetime import datetime, timezone

import httpx
import pytest

import samples
import tools
from conftest import make_client

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 11, 8, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def fixed_now(monkeypatch):
    monkeypatch.setattr(tools, "utcnow", lambda: NOW)


# --- verdict logic ------------------------------------------------------------


def test_verdict_active():
    verdict, reason = tools.health_verdict(False, 30, 160, 160)
    assert verdict == "active" and "30 days ago" in reason


def test_verdict_active_at_exactly_one_year():
    assert tools.health_verdict(False, 365, 160, 160)[0] == "active"


def test_verdict_stale_when_over_a_year():
    verdict, reason = tools.health_verdict(False, 366, 160, 160)
    assert verdict == "stale" and "over a year" in reason


def test_verdict_stale_when_old_and_low_score():
    verdict, reason = tools.health_verdict(False, 200, 70, 160)
    assert verdict == "stale" and "70/160" in reason


def test_verdict_recent_with_low_score_is_still_active():
    assert tools.health_verdict(False, 30, 20, 160)[0] == "active"


def test_verdict_old_but_decent_score_is_active():
    assert tools.health_verdict(False, 200, 120, 160)[0] == "active"


def test_verdict_discontinued_wins():
    verdict, _ = tools.health_verdict(True, 1, 160, 160)
    assert verdict == "discontinued"


def test_verdict_missing_date_is_stale():
    assert tools.health_verdict(False, None, 160, 160)[0] == "stale"


def test_verdict_zero_max_points():
    assert tools.health_verdict(False, 200, 0, 0)[0] == "stale"


# --- compare_packages ---------------------------------------------------------------


def _compare_routes():
    return {
        **samples.routes_for("dio", "5.11.1", "2026-10-20T00:00:00Z", points=160, likes=8000, downloads=5000),
        **samples.routes_for("http", "1.2.0", "2024-01-01T00:00:00Z", points=150, likes=9000, downloads=9000),
        "/api/packages/pedantic": samples.package("pedantic", isDiscontinued=True, replacedBy="lints"),
        "/api/packages/pedantic/score": samples.score(
            points=160, likes=500, downloads=99999, extra_tags=["is:discontinued"]
        ),
    }


async def test_compare_three_packages_with_verdicts():
    result = await tools.compare_packages(make_client(_compare_routes()), ["dio", "http", "pedantic"])
    rows = {r["name"]: r for r in result["packages"]}
    assert rows["dio"]["verdict"] == "active"
    assert rows["http"]["verdict"] == "stale"
    assert rows["pedantic"]["verdict"] == "discontinued"
    assert rows["pedantic"]["replaced_by"] == "lints"
    assert rows["dio"]["pub_points"] == "160/160"
    assert rows["dio"]["days_since_publish"] == 19
    assert rows["dio"]["null_safe"] and rows["dio"]["dart3_compatible"]
    assert "pub_points_granted" not in rows["dio"]
    # discontinued packages never count as leaders
    assert result["leaders"] == {"pub_points": "dio", "likes": "http", "downloads_30d": "http"}
    assert "stale" in result["verdict_rules"]


async def test_compare_normalizes_and_dedupes_names():
    result = await tools.compare_packages(make_client(_compare_routes()), [" DIO", "dio", "http"])
    assert [r["name"] for r in result["packages"]] == ["dio", "http"]


async def test_compare_reports_unknown_package_without_failing_the_rest():
    result = await tools.compare_packages(make_client(_compare_routes()), ["dio", "ghost_pkg"])
    rows = {r["name"]: r for r in result["packages"]}
    assert rows["dio"]["verdict"] == "active"
    assert rows["ghost_pkg"] == {"name": "ghost_pkg", "error": "Package 'ghost_pkg' not found on pub.dev."}
    assert result["leaders"]["likes"] == "dio"


async def test_compare_timeout_for_one_package():
    routes = _compare_routes()
    routes["/api/packages/http"] = httpx.ReadTimeout("slow")
    result = await tools.compare_packages(make_client(routes), ["dio", "http"])
    assert "did not respond" in result["packages"][1]["error"]


async def test_compare_all_failing_has_no_leaders():
    result = await tools.compare_packages(make_client({}), ["aaa", "bbb"])
    assert result["leaders"] == {"pub_points": None, "likes": None, "downloads_30d": None}


@pytest.mark.parametrize("names", [[], ["dio"], ["dio", "DIO"], ["dio", " "], "dio"])
async def test_compare_rejects_fewer_than_two(names):
    result = await tools.compare_packages(make_client(_compare_routes()), names)
    assert "error" in result and "packages" not in result


async def test_compare_rejects_more_than_five():
    names = ["a", "b", "c", "d", "e", "f"]
    result = await tools.compare_packages(make_client({}), names)
    assert result["error"] == "Compare at most 5 packages at a time (got 6)."


async def test_compare_accepts_exactly_five():
    routes = {}
    for n in "abcde":
        routes.update(samples.routes_for(n))
    result = await tools.compare_packages(make_client(routes), list("abcde"))
    assert len(result["packages"]) == 5


async def test_compare_accepts_exactly_two():
    result = await tools.compare_packages(make_client(_compare_routes()), ["dio", "http"])
    assert len(result["packages"]) == 2


# --- publisher_packages -------------------------------------------------------------


def _publisher_routes():
    return {
        "/api/publishers/jneela.dev": {
            "description": "",
            "websiteUrl": "https://jneela.dev/",
            "contactEmail": "private@example.com",
        },
        "/api/search": samples.search("lifecycle_logger", "broken_glass"),
        **samples.routes_for("lifecycle_logger", "0.2.0", "2026-10-01T00:00:00Z"),
        "/api/packages/broken_glass": samples.package("broken_glass", "1.0.0", isDiscontinued=True),
    }


async def test_publisher_packages_parses_response():
    result = await tools.publisher_packages(make_client(_publisher_routes()), "JNeela.dev")
    assert result["publisher"] == "jneela.dev"
    assert result["website"] == "https://jneela.dev/"
    assert result["package_count"] == 2
    first, second = result["packages"]
    assert first["name"] == "lifecycle_logger"
    assert first["latest_version"] == "0.2.0"
    assert first["last_published"] == "2026-10-01"
    assert first["discontinued"] is False
    assert second["discontinued"] is True
    assert "note" not in result
    assert "private@example.com" not in str(result)


async def test_publisher_search_uses_publisher_filter():
    client = make_client(_publisher_routes())
    await tools.publisher_packages(client, "jneela.dev")
    assert any("q=publisher%3Ajneela.dev" in c or "q=publisher:jneela.dev" in c for c in client.calls)


async def test_publisher_follows_pages():
    routes = _publisher_routes()
    routes["/api/search?q=publisher%3Ajneela.dev&page=1"] = samples.search("lifecycle_logger", next_url="x")
    routes["/api/search?q=publisher%3Ajneela.dev&page=2"] = samples.search("broken_glass")
    result = await tools.publisher_packages(make_client(routes), "jneela.dev")
    assert result["package_count"] == 2


async def test_publisher_with_no_packages():
    routes = {"/api/publishers/empty.dev": {"websiteUrl": None}, "/api/search": {"packages": []}}
    result = await tools.publisher_packages(make_client(routes), "empty.dev")
    assert result["package_count"] == 0 and "no public packages" in result["note"]


async def test_publisher_caps_listing():
    names = [f"pkg_{i}" for i in range(40)]
    routes = {"/api/publishers/big.dev": {}, "/api/search": samples.search(*names)}
    for n in names:
        routes[f"/api/packages/{n}"] = samples.package(n)
    result = await tools.publisher_packages(make_client(routes), "big.dev")
    assert result["package_count"] == 40 and len(result["packages"]) == 30
    assert "first 30 of 40" in result["note"]


async def test_publisher_package_failure_is_reported_per_row():
    routes = _publisher_routes()
    routes["/api/packages/broken_glass"] = (500, "x")
    result = await tools.publisher_packages(make_client(routes), "jneela.dev")
    assert "HTTP 500" in result["packages"][1]["error"]


async def test_unknown_publisher_is_friendly():
    result = await tools.publisher_packages(make_client({}), "ghost.dev")
    assert result == {"error": "Publisher 'ghost.dev' not found on pub.dev."}


async def test_invalid_publisher_is_friendly():
    result = await tools.publisher_packages(make_client({}), "bad id!")
    assert "not a valid publisher id" in result["error"]


async def test_publisher_5xx_and_timeout():
    down = make_client({"/api/publishers/x.dev": (503, "down")})
    assert "HTTP 503" in (await tools.publisher_packages(down, "x.dev"))["error"]
    slow = make_client({"/api/publishers/x.dev": httpx.ReadTimeout("t")})
    assert "did not respond" in (await tools.publisher_packages(slow, "x.dev"))["error"]
