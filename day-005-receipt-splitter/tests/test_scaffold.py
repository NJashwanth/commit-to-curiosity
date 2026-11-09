import importlib

import pytest


@pytest.mark.parametrize(
    "module", ["models", "images", "extract", "sanity", "splitter", "split"]
)
def test_module_layout_imports(module):
    assert importlib.import_module(module).__doc__
