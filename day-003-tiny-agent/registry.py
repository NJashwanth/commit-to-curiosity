"""Tool registry: JSON schemas for the API and dispatch by name."""
import json

import calculator
import files
import weather
from errors import ToolError

# name -> (schema, function). Adding a tool means adding one line here.
_TOOLS = {
    "calculator": (calculator.SCHEMA, calculator.calculate),
    "list_files": (files.LIST_FILES_SCHEMA, files.list_files),
    "read_file": (files.READ_FILE_SCHEMA, files.read_file),
    "save_note": (files.SAVE_NOTE_SCHEMA, files.save_note),
    "get_weather": (weather.SCHEMA, weather.get_weather),
}


def tool_schemas():
    """The `tools` list to pass to the Messages API."""
    return [schema for schema, _ in _TOOLS.values()]


def execute_tool(name, tool_input):
    """Run a tool by name and return its result as a string. Raises on any failure."""
    if name not in _TOOLS:
        raise ToolError(f"Unknown tool: {name}. Available tools: {', '.join(_TOOLS)}.")
    if not isinstance(tool_input, dict):
        raise ToolError("Tool input must be a JSON object.")
    _, func = _TOOLS[name]
    try:
        result = func(**tool_input)
    except TypeError as exc:
        # Wrong or missing argument names from the model, not a bug in the tool.
        raise ToolError(f"Bad arguments for {name}: {exc}") from None
    return result if isinstance(result, str) else json.dumps(result)
