import pytest


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Keep tests hermetic: no real key, no model override from the host."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("RECEIPT_MODEL", raising=False)
