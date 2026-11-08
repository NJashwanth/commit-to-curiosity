from datetime import datetime, timezone

import httpx
import pytest

import samples
import tools
from conftest import make_client

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def fixed_now(monkeypatch):
    monkeypatch.setattr(tools, "utcnow", lambda: datetime(2026, 11, 8, tzinfo=timezone.utc))


# --- search_packages --------------------------------------------------------


async def test_search_parses_results():
    client = make_client(
        {
            "/api/search": samples.search("dio", "http"),
            **samples.routes_for("dio", "5.11.1", likes=8373, downloads=5424731),
            **samples.routes_for("http", "1.2.0", points=150, likes=1000, downloads=50),
        }
    )
    result = await tools.search_packages(client, "http client", limit=2)
    assert result["query"] == "http client"
    assert result["count"] == 2
    dio, http = result["results"]
    assert dio == {
        "name": "dio",
        "description": "A powerful HTTP networking package, supports Interceptors, and more.",
        "latest_version": "5.11.1",
        "likes": 8373,
        "pub_points": "160/160",
        "downloads_30d": 5424731,
    }
    assert http["pub_points"] == "150/160"


async def test_search_respects_limit_and_follows_pages():
    client = make_client(
        {
            "/api/search?q=state&page=1": samples.search("a", "b", next_url="https://pub.dev/api/search?q=state&page=2"),
            "/api/search?q=state&page=2": samples.search("c", "d"),
            **samples.routes_for("a"),
            **samples.routes_for("b"),
            **samples.routes_for("c"),
        }
    )
    result = await tools.search_packages(client, "state", limit=3)
    assert [r["name"] for r in result["results"]] == ["a", "b", "c"]


async def test_search_clamps_limit():
    client = make_client({"/api/search": samples.search("a"), **samples.routes_for("a")})
    assert (await tools.search_packages(client, "x", limit=0))["count"] == 1
    assert (await tools.search_packages(client, "x", limit=999))["count"] == 1


async def test_search_no_matches():
    client = make_client({"/api/search": {"packages": []}})
    result = await tools.search_packages(client, "zzzz")
    assert result["count"] == 0 and "No packages" in result["note"]


async def test_search_blank_query():
    result = await tools.search_packages(make_client({}), "   ")
    assert "error" in result


async def test_search_keeps_going_when_one_package_fails():
    client = make_client(
        {
            "/api/search": samples.search("good", "bad"),
            **samples.routes_for("good"),
            "/api/packages/bad": (503, "down"),
            "/api/packages/bad/score": (503, "down"),
        }
    )
    result = await tools.search_packages(client, "x")
    assert result["results"][0]["name"] == "good"
    assert "HTTP 503" in result["results"][1]["error"]


async def test_search_timeout_is_friendly_error():
    client = make_client({"/api/search": httpx.ReadTimeout("slow")})
    result = await tools.search_packages(client, "dio")
    assert "did not respond" in result["error"]


# --- package_info -----------------------------------------------------------


async def test_package_info_parses_fields():
    client = make_client(samples.routes_for("dio", "5.11.1", "2026-09-04T02:46:21.721502Z"))
    info = await tools.package_info(client, "dio")
    assert info["name"] == "dio"
    assert info["latest_version"] == "5.11.1"
    assert info["publisher"] == "flutter.cn"
    assert info["last_published"] == "2026-09-04"
    assert info["days_since_publish"] == 64
    assert info["sdk_constraints"] == {"sdk": ">=2.18.0 <4.0.0"}
    assert info["sdks"] == ["dart", "flutter"]
    assert info["platforms"] == ["android", "ios", "web"]
    assert info["repository"].endswith("/dio/blob/main/dio")
    assert info["homepage"] == "https://github.com/example/dio"
    assert info["topics"] == ["http", "network"]
    assert info["discontinued"] is False
    assert info["url"] == "https://pub.dev/packages/dio"
    assert "replaced_by" not in info


async def test_package_info_discontinued_with_replacement():
    routes = {
        "/api/packages/pedantic": samples.package("pedantic", isDiscontinued=True, replacedBy="lints"),
        "/api/packages/pedantic/score": samples.score(extra_tags=["is:discontinued"]),
    }
    info = await tools.package_info(make_client(routes), "pedantic")
    assert info["discontinued"] is True
    assert info["replaced_by"] == "lints"


async def test_package_info_handles_sparse_data():
    routes = {
        "/api/packages/tiny": {"name": "tiny", "latest": {"version": "0.0.1", "pubspec": {}}},
        "/api/packages/tiny/score": {"grantedPoints": 0, "maxPoints": 160},
    }
    info = await tools.package_info(make_client(routes), "tiny")
    assert info["publisher"] is None
    assert info["last_published"] is None and info["days_since_publish"] is None
    assert info["description"] is None


async def test_unknown_package_is_friendly():
    result = await tools.package_info(make_client({}), "nope_pkg")
    assert result == {"error": "Package 'nope_pkg' not found on pub.dev."}


async def test_invalid_package_name_is_friendly():
    result = await tools.package_info(make_client({}), "../etc/passwd")
    assert "not a valid package name" in result["error"]


async def test_package_info_5xx_and_timeout():
    down = make_client({"/api/packages/dio": (500, "x"), "/api/packages/dio/score": (500, "x")})
    assert "HTTP 500" in (await tools.package_info(down, "dio"))["error"]
    slow = make_client({"/api/packages/dio": httpx.ConnectTimeout("t"), "/api/packages/dio/score": {}})
    assert "did not respond" in (await tools.package_info(slow, "dio"))["error"]


async def test_long_description_is_truncated():
    pkg = samples.package("wordy")
    pkg["latest"]["pubspec"]["description"] = "word " * 100
    routes = {"/api/packages/wordy": pkg, "/api/packages/wordy/score": samples.score()}
    info = await tools.package_info(make_client(routes), "wordy")
    assert len(info["description"]) == 200 and info["description"].endswith("...")


async def test_bad_timestamp_is_ignored():
    pkg = samples.package("odd", published="not-a-date")
    routes = {"/api/packages/odd": pkg, "/api/packages/odd/score": samples.score()}
    assert (await tools.package_info(make_client(routes), "odd"))["last_published"] is None


async def test_naive_timestamp_treated_as_utc():
    pkg = samples.package("naive", published="2026-11-01T00:00:00")
    routes = {"/api/packages/naive": pkg, "/api/packages/naive/score": samples.score()}
    assert (await tools.package_info(make_client(routes), "naive"))["days_since_publish"] == 7


# --- package_score ----------------------------------------------------------


async def test_package_score_parses_everything():
    routes = {
        **samples.routes_for("dio"),
        "/api/packages/dio/metrics": samples.metrics(),
    }
    result = await tools.package_score(make_client(routes), "dio")
    assert result["pub_points"] == "160/160"
    assert result["likes"] == 8373
    assert result["downloads_30d"] == 5424731
    assert result["flags"] == {
        "null_safe": True,
        "dart3_compatible": True,
        "wasm_ready": True,
        "flutter_favorite": False,
        "discontinued": False,
    }
    assert result["platforms"] == ["android", "ios", "web"]
    assert result["licenses"] == ["mit"]
    assert result["pub_points_breakdown"] == [
        {"area": "Follow Dart file conventions", "points": "30/30", "status": "passed"},
        {"area": "Pass static analysis", "points": "40/50", "status": "partial"},
    ]


async def test_package_score_without_metrics_still_works():
    result = await tools.package_score(make_client(samples.routes_for("dio")), "dio")
    assert result["pub_points"] == "160/160"
    assert "pub_points_breakdown" not in result


async def test_package_score_empty_report_has_no_breakdown():
    routes = {**samples.routes_for("dio"), "/api/packages/dio/metrics": {"scorecard": {}}}
    assert "pub_points_breakdown" not in await tools.package_score(make_client(routes), "dio")


async def test_package_score_discontinued_flag():
    routes = {
        "/api/packages/old": samples.package("old", isDiscontinued=True, replacedBy="new"),
        "/api/packages/old/score": samples.score(extra_tags=["is:discontinued"]),
    }
    result = await tools.package_score(make_client(routes), "old")
    assert result["flags"]["discontinued"] is True
    assert result["replaced_by"] == "new"


async def test_package_score_unknown_package():
    result = await tools.package_score(make_client({}), "ghost")
    assert "not found" in result["error"]


def test_utcnow_is_timezone_aware(monkeypatch):
    monkeypatch.undo()
    assert tools.utcnow().tzinfo is not None
