"""Async pub.dev API client with timeouts, friendly errors and a 10 minute cache."""
import re
from typing import Any
from urllib.parse import quote

import httpx

from cache import TTLCache

BASE_URL = "https://pub.dev"
CACHE_TTL_SECONDS = 600
TIMEOUT_SECONDS = 10.0
HEADERS = {
    "Accept": "application/vnd.pub.v2+json",
    "User-Agent": "pubdev-mcp/0.1 (+https://github.com/njashwanth/commit-to-curiosity)",
}

_PACKAGE_RE = re.compile(r"^[a-z0-9_]{1,100}$")
_PUBLISHER_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,99}$")


class PubDevError(Exception):
    """An error whose message is safe to show to the user as-is."""


class NotFoundError(PubDevError):
    """The requested package or publisher does not exist."""


def normalize_package(name: str) -> str:
    cleaned = str(name).strip().lower()
    if not _PACKAGE_RE.match(cleaned):
        raise PubDevError(
            f"'{name}' is not a valid package name (use lowercase letters, digits and underscores)."
        )
    return cleaned


def normalize_publisher(publisher: str) -> str:
    cleaned = str(publisher).strip().lower()
    if not _PUBLISHER_RE.match(cleaned):
        raise PubDevError(f"'{publisher}' is not a valid publisher id (for example 'dart.dev').")
    return cleaned


class PubDevClient:
    def __init__(
        self,
        transport: httpx.AsyncBaseTransport | None = None,
        cache: TTLCache | None = None,
        timeout: float = TIMEOUT_SECONDS,
    ):
        self._transport = transport
        self._timeout = timeout
        self._http: httpx.AsyncClient | None = None
        self.cache = cache if cache is not None else TTLCache(CACHE_TTL_SECONDS)

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                base_url=BASE_URL,
                headers=HEADERS,
                timeout=self._timeout,
                transport=self._transport,
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def get_json(
        self, path: str, params: dict[str, Any] | None = None, what: str = "resource"
    ) -> Any:
        """GET a JSON document, served from cache when fresh. Raises PubDevError."""
        key = (path, tuple(sorted((params or {}).items())))
        cached = self.cache.get(key)
        if cached is not None:
            return cached

        try:
            response = await self._client().get(path, params=params)
        except httpx.TimeoutException:
            raise PubDevError(
                f"pub.dev did not respond within {self._timeout:g}s. Try again in a moment."
            ) from None
        except httpx.HTTPError as exc:
            raise PubDevError(f"Could not reach pub.dev ({type(exc).__name__}).") from None

        if response.status_code == 404:
            raise NotFoundError(f"{what} not found on pub.dev.")
        if response.status_code >= 500:
            raise PubDevError(
                f"pub.dev is having problems (HTTP {response.status_code}). Try again later."
            )
        if response.status_code >= 400:
            raise PubDevError(f"pub.dev rejected the request (HTTP {response.status_code}).")
        try:
            data = response.json()
        except ValueError:
            raise PubDevError("pub.dev returned a response that is not valid JSON.") from None

        self.cache.set(key, data)
        return data

    # --- endpoint helpers -------------------------------------------------

    async def search(self, query: str, page: int = 1) -> dict[str, Any]:
        return await self.get_json("/api/search", {"q": query, "page": page}, "Search")

    async def package(self, name: str) -> dict[str, Any]:
        name = normalize_package(name)
        return await self.get_json(
            f"/api/packages/{quote(name)}", what=f"Package '{name}'"
        )

    async def score(self, name: str) -> dict[str, Any]:
        name = normalize_package(name)
        return await self.get_json(
            f"/api/packages/{quote(name)}/score", what=f"Package '{name}'"
        )

    async def publisher(self, publisher: str) -> dict[str, Any]:
        publisher = normalize_publisher(publisher)
        return await self.get_json(
            f"/api/publishers/{quote(publisher)}", what=f"Publisher '{publisher}'"
        )

    async def metrics(self, name: str) -> dict[str, Any]:
        """Score plus the pana report (pub points breakdown)."""
        name = normalize_package(name)
        return await self.get_json(
            f"/api/packages/{quote(name)}/metrics", what=f"Package '{name}'"
        )
