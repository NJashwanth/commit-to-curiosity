"""Tiny stand-ins for the Anthropic client so tests never touch the network."""

from types import SimpleNamespace


class FakeMessages:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def create(self, **kwargs):
        # Snapshot messages: the caller builds new lists, but be safe.
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        text = self.replies.pop(0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])


class FakeClient:
    def __init__(self, replies):
        self.messages = FakeMessages(replies)
