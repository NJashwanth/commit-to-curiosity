import os

import pytest
from helpers import mg

# Fixed identity and dates so real git and mini-git produce the same commit ids.
FIXED_ENV = {
    "GIT_AUTHOR_NAME": "Test Author",
    "GIT_AUTHOR_EMAIL": "author@example.com",
    "GIT_COMMITTER_NAME": "Test Committer",
    "GIT_COMMITTER_EMAIL": "committer@example.com",
    "GIT_AUTHOR_DATE": "1700000000 +0530",
    "GIT_COMMITTER_DATE": "1700000000 +0530",
}


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    """Keep both gits away from the developer's real config and identity."""
    for key in list(os.environ):
        if key.startswith("GIT_"):
            monkeypatch.delenv(key)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.delenv("NO_COLOR", raising=False)
    for key, value in FIXED_ENV.items():
        monkeypatch.setenv(key, value)
    return home


@pytest.fixture
def repo(tmp_path):
    """An empty repository created by mini-git."""
    path = tmp_path / "repo"
    path.mkdir()
    mg(path, "init")
    return path
