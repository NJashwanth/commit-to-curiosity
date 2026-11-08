from cache import TTLCache


def test_returns_value_within_ttl(clock):
    cache = TTLCache(600, clock)
    cache.set("k", {"a": 1})
    clock.advance(599)
    assert cache.get("k") == {"a": 1}
    assert len(cache) == 1


def test_expires_after_ttl(clock):
    cache = TTLCache(600, clock)
    cache.set("k", "v")
    clock.advance(600)
    assert cache.get("k") is None
    assert len(cache) == 0


def test_missing_key_returns_default(clock):
    assert TTLCache(600, clock).get("nope", "fallback") == "fallback"


def test_clear(clock):
    cache = TTLCache(600, clock)
    cache.set("k", 1)
    cache.clear()
    assert cache.get("k") is None
