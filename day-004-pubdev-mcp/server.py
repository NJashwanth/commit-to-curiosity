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


@mcp.tool()
async def compare_packages(names: list[str]) -> dict[str, Any]:
    """Compare 2 to 5 packages side by side (version, last publish, pub points, likes,
    downloads, null safety, Dart 3, platforms) with a health verdict for each:
    active, stale or discontinued."""
    return await tools.compare_packages(_client, names)


@mcp.tool()
async def publisher_packages(publisher: str) -> dict[str, Any]:
    """List the packages owned by a pub.dev verified publisher, for example 'dart.dev'
    or 'jneela.dev', with latest version, description and last publish date."""
    return await tools.publisher_packages(_client, publisher)


@mcp.prompt()
def pick_package(use_case: str) -> str:
    """Guide Claude to search pub.dev, compare the best candidates and recommend one."""
    return (
        f"I need a Dart/Flutter package for: {use_case}\n\n"
        "Use the pubdev tools to pick one:\n"
        "1. Call search_packages with a few different phrasings of the use case "
        "(limit 10) and shortlist the 3 to 5 strongest candidates by pub points, likes and downloads.\n"
        "2. Call compare_packages on the shortlist. Drop anything stale or discontinued "
        "unless it is the only option.\n"
        "3. Call package_info and package_score on the top one or two to check SDK constraints, "
        "platform support, the publisher, and null safety / Dart 3 compatibility.\n"
        "4. Recommend one package. Give the reasons in a few bullets, name a runner-up, and say "
        "when you would choose the runner-up instead. Mention any risk, such as a single "
        "maintainer, an old last publish date or a missing platform.\n"
        "Base every claim on the tool results, and say so if a tool returned an error."
    )


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":  # pragma: no cover
    main()
