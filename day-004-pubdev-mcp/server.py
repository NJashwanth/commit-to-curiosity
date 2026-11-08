"""FastMCP server exposing pub.dev tools over stdio."""
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("pubdev")


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":  # pragma: no cover
    main()
