import pytest

import server

pytestmark = pytest.mark.anyio


EXPECTED_TOOLS = {
    "search_packages": ["query"],
    "package_info": ["name"],
    "package_score": ["name"],
    "compare_packages": ["names"],
    "publisher_packages": ["publisher"],
}


async def test_registers_all_five_tools_with_valid_schemas():
    tools = {t.name: t for t in await server.mcp.list_tools()}
    assert set(tools) == set(EXPECTED_TOOLS)
    for name, required in EXPECTED_TOOLS.items():
        schema = tools[name].inputSchema
        assert schema["type"] == "object"
        assert schema["required"] == required
        assert set(required) <= set(schema["properties"])
        assert tools[name].description


async def test_tool_schema_details():
    tools = {t.name: t for t in await server.mcp.list_tools()}
    assert tools["search_packages"].inputSchema["properties"]["limit"]["default"] == 10
    names = tools["compare_packages"].inputSchema["properties"]["names"]
    assert names["type"] == "array" and names["items"] == {"type": "string"}


async def test_registers_pick_package_prompt():
    prompts = await server.mcp.list_prompts()
    assert [p.name for p in prompts] == ["pick_package"]
    arg = prompts[0].arguments[0]
    assert arg.name == "use_case" and arg.required


async def test_pick_package_prompt_guides_search_compare_recommend():
    result = await server.mcp.get_prompt("pick_package", {"use_case": "state management"})
    text = result.messages[0].content.text
    assert "state management" in text
    for tool in ("search_packages", "compare_packages", "package_info", "package_score"):
        assert tool in text
    assert "Recommend" in text


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


async def test_compare_and_publisher_run_through_the_server(monkeypatch):
    from conftest import make_client
    import samples

    routes = {
        **samples.routes_for("dio"),
        **samples.routes_for("http"),
        "/api/publishers/jneela.dev": {"websiteUrl": "https://jneela.dev/"},
        "/api/search": samples.search("dio"),
    }
    monkeypatch.setattr(server, "_client", make_client(routes))

    _, compared = await server.mcp.call_tool("compare_packages", {"names": ["dio", "http"]})
    assert len(compared["packages"]) == 2
    _, too_few = await server.mcp.call_tool("compare_packages", {"names": ["dio"]})
    assert "at least 2" in too_few["error"]
    _, pub = await server.mcp.call_tool("publisher_packages", {"publisher": "jneela.dev"})
    assert pub["packages"][0]["name"] == "dio"
