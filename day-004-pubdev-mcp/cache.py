"""In-memory TTL cache."""
import time
from typing import Any, Callable

_MISSING = object()


class TTLCache:
    """Tiny dict-backed cache whose entries expire after `ttl` seconds.

    The clock is injectable so tests can move time without sleeping.
    """

    def __init__(self, ttl: float = 600.0, clock: Callable[[], float] = time.monotonic):
        self.ttl = ttl
        self._clock = clock
        self._items: dict[Any, tuple[float, Any]] = {}

    def get(self, key: Any, default: Any = None) -> Any:
        entry = self._items.get(key, _MISSING)
        if entry is _MISSING:
            return default
        stored_at, value = entry
        if self._clock() - stored_at >= self.ttl:
            del self._items[key]
            return default
        return value

    def set(self, key: Any, value: Any) -> None:
        self._items[key] = (self._clock(), value)

    def clear(self) -> None:
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)
