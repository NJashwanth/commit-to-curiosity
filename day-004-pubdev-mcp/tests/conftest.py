import httpx
import pytest

from cache import TTLCache
from client import PubDevClient


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def clock():
    return FakeClock()


def make_client(routes, clock=None):
    """Build a PubDevClient backed by a fake transport.

    `routes` maps a request path (or "path?query") to either a JSON-able body,
    an (status, body) tuple, or an Exception instance to raise. The returned
    client has a `.calls` list of requested URLs.
    """
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        key = request.url.path
        if request.url.query:
            full = f"{key}?{request.url.query.decode()}"
            if full in routes:
                key = full
        if key not in routes:
            return httpx.Response(404, text="<Error>NoSuchKey</Error>")
        target = routes[key]
        if isinstance(target, Exception):
            raise target
        if isinstance(target, tuple):
            status, body = target
            if isinstance(body, str):
                return httpx.Response(status, text=body)
            return httpx.Response(status, json=body)
        return httpx.Response(200, json=target)

    cache = TTLCache(600, clock) if clock else None
    client = PubDevClient(transport=httpx.MockTransport(handler), cache=cache)
    client.calls = calls
    return client
