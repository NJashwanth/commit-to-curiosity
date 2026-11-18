"""The one exception type every command raises for user-facing failures."""

from __future__ import annotations


class GitError(Exception):
    """A failure reported to the user the way Git does: ``fatal: ...`` and an exit code.

    ``notes`` are printed before the final line (Git uses them for ``error:`` and
    ``hint:`` lines, as in the short-SHA ambiguity message).
    """

    def __init__(self, message: str, *, code: int = 128, prefix: str = "fatal", notes=()):
        super().__init__(message)
        self.message = message
        self.code = code
        self.prefix = prefix
        self.notes = list(notes)

    def render(self) -> str:
        last = f"{self.prefix}: {self.message}" if self.prefix else self.message
        return "\n".join([*self.notes, last])
