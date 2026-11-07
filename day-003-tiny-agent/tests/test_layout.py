"""Scaffold checks: the module layout imports and the sample workspace is in place."""
import importlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
MODULES = ["errors", "calculator", "files", "weather", "registry", "loop", "agent"]
SAMPLES = ["notes.md", "budget.csv", "trip-plan.md"]


@pytest.mark.parametrize("name", MODULES)
def test_module_imports(name):
    assert importlib.import_module(name)


@pytest.mark.parametrize("name", SAMPLES)
def test_sample_workspace_file_exists(name):
    assert (ROOT / "workspace" / name).read_text(encoding="utf-8").strip()


def test_env_example_has_api_key_placeholder():
    assert "ANTHROPIC_API_KEY=" in (ROOT / ".env.example").read_text(encoding="utf-8")


def test_tool_error_carries_retryable_flag():
    from errors import ToolError

    assert ToolError("boom").retryable is False
    assert ToolError("blip", retryable=True).retryable is True
