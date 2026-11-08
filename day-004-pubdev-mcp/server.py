"""FastMCP server exposing pub.dev tools over stdio."""
from typing import Any

from mcp.server.fastmcp import FastMCP

import tools
from client import PubDevClient

mcp = FastMCP("pubdev")
_client = PubDevClient()


@mcp.tool()
async def search_packages(query: str, limit: int = 10) -> dict[str, Any]:
    """Search pub.dev for Dart and Flutter packages.

    Returns up to `limit` (1-25) matches with name, description, latest version,
    likes, pub points (granted/max) and downloads in the last 30 days.
    """
    return await tools.search_packages(_client, query, limit)


@mcp.tool()
async def package_info(name: str) -> dict[str, Any]:
    """Details for one package: latest version, publisher, SDK constraints,
    supported platforms, repository and homepage links, and last published date."""
    return await tools.package_info(_client, name)


@mcp.tool()
async def package_score(name: str) -> dict[str, Any]:
    """Quality signals for one package: pub points with per-area breakdown, likes,
    30 day downloads, and flags such as null safety, Dart 3 compatibility and
    discontinued status."""
    return await tools.package_score(_client, name)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":  # pragma: no cover
    main()
