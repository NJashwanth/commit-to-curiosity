import cache
import client
import server
import tools


def test_modules_import():
    for module in (cache, client, tools):
        assert module.__doc__


def test_server_is_named_pubdev():
    assert server.mcp.name == "pubdev"
