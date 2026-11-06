"""Smoke test: every module in the layout imports."""
import importlib

import pytest

MODULES = ["repo", "chunker", "index", "retrieval", "answer", "ask"]


@pytest.mark.parametrize("name", MODULES)
def test_module_imports(name):
    assert importlib.import_module(name).__doc__
