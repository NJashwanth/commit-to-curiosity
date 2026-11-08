import httpx
import pytest

from client import (
    NotFoundError,
    PubDevClient,
    PubDevError,
    normalize_package,
    normalize_publisher,
)
from conftest import make_client

pytestmark = pytest.mark.anyio


async def test_get_json_parses_and_sends_headers():
    seen = {}

    def handler(request):
        seen.update(request.headers)
        return httpx.Response(200, json={"ok": True})

    client = PubDevClient(transport=httpx.MockTransport(handler))
    assert await client.get_json("/api/x") == {"ok": True}
    assert seen["accept"] == "application/vnd.pub.v2+json"
    assert "pubdev-mcp" in seen["user-agent"]
    await client.aclose()


async def test_endpoint_helpers_hit_expected_paths():
    client = make_client(
        {
            "/api/search": {"packages": []},
            "/api/packages/dio": {"name": "dio"},
            "/api/packages/dio/score": {"grantedPoints": 1},
            "/api/publishers/dart.dev": {"websiteUrl": "x"},
        }
    )
    assert await client.search("dio", page=2) == {"packages": []}
    assert "q=dio" in client.calls[0] and "page=2" in client.calls[0]
    assert (await client.package(" DIO "))["name"] == "dio"
    assert (await client.score("dio"))["grantedPoints"] == 1
    assert (await client.publisher("dart.dev"))["websiteUrl"] == "x"


async def test_404_is_not_found_with_friendly_message():
    client = make_client({})
    with pytest.raises(NotFoundError, match="Package 'nope' not found"):
        await client.package("nope")


async def test_404_publisher_message():
    client = make_client({"/api/publishers/ghost.dev": (404, {"error": {"code": "NotFound"}})})
    with pytest.raises(NotFoundError, match="Publisher 'ghost.dev' not found"):
        await client.publisher("ghost.dev")


@pytest.mark.parametrize("status", [500, 502, 503])
async def test_5xx_is_friendly(status):
    client = make_client({"/api/packages/dio": (status, "boom")})
    with pytest.raises(PubDevError, match=f"HTTP {status}") as exc:
        await client.package("dio")
    assert not isinstance(exc.value, NotFoundError)


async def test_other_4xx_is_friendly():
    client = make_client({"/api/packages/dio": (429, "slow down")})
    with pytest.raises(PubDevError, match="rejected the request \\(HTTP 429\\)"):
        await client.package("dio")


async def test_timeout_is_friendly():
    client = make_client({"/api/packages/dio": httpx.ReadTimeout("slow")})
    with pytest.raises(PubDevError, match="did not respond within"):
        await client.package("dio")


async def test_connection_error_is_friendly():
    client = make_client({"/api/packages/dio": httpx.ConnectError("down")})
    with pytest.raises(PubDevError, match="Could not reach pub.dev \\(ConnectError\\)"):
        await client.package("dio")


async def test_invalid_json_is_friendly():
    client = make_client({"/api/packages/dio": (200, "<html>nope</html>")})
    with pytest.raises(PubDevError, match="not valid JSON"):
        await client.package("dio")


async def test_cache_serves_within_ttl_and_refetches_after_expiry(clock):
    client = make_client({"/api/packages/dio": {"name": "dio"}}, clock)
    await client.package("dio")
    clock.advance(599)
    await client.package("dio")
    assert len(client.calls) == 1

    clock.advance(2)
    await client.package("dio")
    assert len(client.calls) == 2


async def test_cache_key_includes_query_params(clock):
    client = make_client({"/api/search": {"packages": []}}, clock)
    await client.search("a")
    await client.search("b")
    await client.search("a")
    assert len(client.calls) == 2


async def test_errors_are_not_cached(clock):
    client = make_client({"/api/packages/dio": (503, "down")}, clock)
    for _ in range(2):
        with pytest.raises(PubDevError):
            await client.package("dio")
    assert len(client.calls) == 2


@pytest.mark.parametrize("bad", ["", "../etc", "has space", "UPPER-dash", "a/b"])
def test_invalid_package_names_rejected(bad):
    with pytest.raises(PubDevError, match="not a valid package name"):
        normalize_package(bad)


@pytest.mark.parametrize("bad", ["", "-x", "a/b", "has space"])
def test_invalid_publisher_ids_rejected(bad):
    with pytest.raises(PubDevError, match="not a valid publisher id"):
        normalize_publisher(bad)


def test_normalize_accepts_good_values():
    assert normalize_package(" Flutter_Bloc ") == "flutter_bloc"
    assert normalize_publisher("JNeela.dev") == "jneela.dev"
