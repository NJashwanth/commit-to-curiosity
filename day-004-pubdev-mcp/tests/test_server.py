import pytest

import server

pytestmark = pytest.mark.anyio


async def test_registers_search_info_and_score_tools():
    tools = {t.name: t for t in await server.mcp.list_tools()}
    assert {"search_packages", "package_info", "package_score"} <= set(tools)
    search = tools["search_packages"].inputSchema
    assert search["required"] == ["query"]
    assert search["properties"]["limit"]["default"] == 10
    assert tools["package_info"].inputSchema["required"] == ["name"]
    assert tools["package_score"].inputSchema["required"] == ["name"]
    for tool in tools.values():
        assert tool.description


async def test_tools_run_end_to_end_through_the_server(monkeypatch):
    from conftest import make_client
    import samples

    routes = {
        "/api/search": samples.search("dio"),
        **samples.routes_for("dio", "5.11.1"),
    }
    monkeypatch.setattr(server, "_client", make_client(routes))

    _, found = await server.mcp.call_tool("search_packages", {"query": "dio", "limit": 1})
    assert found["results"][0]["name"] == "dio"
    _, info = await server.mcp.call_tool("package_info", {"name": "dio"})
    assert info["latest_version"] == "5.11.1"
    _, score = await server.mcp.call_tool("package_score", {"name": "dio"})
    assert score["pub_points"] == "160/160"
    _, missing = await server.mcp.call_tool("package_info", {"name": "ghost"})
    assert "not found" in missing["error"]
