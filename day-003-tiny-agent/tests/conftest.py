"""Scripted stand-in for the Anthropic client so tests never touch the network."""
import copy
from types import SimpleNamespace

import pytest


def text_block(text):
    return SimpleNamespace(type="text", text=text)


def tool_block(tool_id, name, tool_input):
    return SimpleNamespace(type="tool_use", id=tool_id, name=name, input=tool_input)


def response(blocks, stop_reason, input_tokens=100, output_tokens=20):
    return SimpleNamespace(
        content=blocks, stop_reason=stop_reason,
        usage=SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens),
    )


def final(text, **kw):
    return response([text_block(text)], "end_turn", **kw)


def tool_turn(*calls, text=None, **kw):
    """calls are (id, name, input) tuples."""
    blocks = ([text_block(text)] if text else []) + [tool_block(*c) for c in calls]
    return response(blocks, "tool_use", **kw)


class ScriptedClient:
    """Returns the scripted responses in order and records every request it was sent."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.requests = []
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.requests.append(copy.deepcopy(kwargs))
        if not self._responses:
            raise AssertionError("ScriptedClient ran out of scripted responses")
        return self._responses.pop(0)


@pytest.fixture
def scripted():
    return ScriptedClient
