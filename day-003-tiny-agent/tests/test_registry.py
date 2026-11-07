import json

import pytest

import registry
from errors import ToolError


def test_schemas_are_valid_api_tool_definitions():
    schemas = registry.tool_schemas()
    names = [s["name"] for s in schemas]
    assert len(names) == len(set(names))
    for schema in schemas:
        assert schema["description"]
        assert schema["input_schema"]["type"] == "object"
        assert "properties" in schema["input_schema"]
        json.dumps(schema)  # must be serialisable


def test_execute_calculator():
    assert registry.execute_tool("calculator", {"expression": "2 * 21"}) == "42"


def test_execute_file_tools_use_the_real_workspace():
    assert "notes.md" in registry.execute_tool("list_files", {})
    assert "Detroit" in registry.execute_tool("read_file", {"path": "trip-plan.md"})


def test_unknown_tool():
    with pytest.raises(ToolError, match="Unknown tool"):
        registry.execute_tool("launch_missiles", {})


def test_bad_arguments_become_tool_errors():
    with pytest.raises(ToolError, match="Bad arguments"):
        registry.execute_tool("calculator", {})
    with pytest.raises(ToolError, match="Bad arguments"):
        registry.execute_tool("calculator", {"expression": "1", "extra": 2})


def test_non_dict_input():
    with pytest.raises(ToolError, match="JSON object"):
        registry.execute_tool("calculator", "1 + 1")


def test_non_string_results_are_json_encoded(monkeypatch):
    monkeypatch.setitem(registry._TOOLS, "dict_tool", ({"name": "dict_tool"}, lambda: {"a": 1}))
    assert registry.execute_tool("dict_tool", {}) == '{"a": 1}'


def test_all_five_tools_registered():
    names = {s["name"] for s in registry.tool_schemas()}
    assert names == {"calculator", "list_files", "read_file", "save_note", "get_weather"}


def test_save_note_through_registry(tmp_path, monkeypatch):
    import files

    monkeypatch.setattr(files, "WORKSPACE", tmp_path)
    assert registry.execute_tool("save_note", {"text": "via registry"}) == "Saved note to notes.md."
    assert "via registry" in (tmp_path / "notes.md").read_text(encoding="utf-8")


def test_get_weather_through_registry_returns_json(monkeypatch):
    import weather

    monkeypatch.setattr(weather, "get_weather", lambda city, units="imperial": {"city": city})
    monkeypatch.setitem(registry._TOOLS, "get_weather", (weather.SCHEMA, weather.get_weather))
    assert json.loads(registry.execute_tool("get_weather", {"city": "Oslo"})) == {"city": "Oslo"}
