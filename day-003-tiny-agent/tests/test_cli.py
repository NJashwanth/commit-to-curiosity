from collections import Counter

from types import SimpleNamespace

import anthropic
import pytest

import agent
from conftest import ScriptedClient, final, tool_turn
from loop import AgentResult


@pytest.fixture(autouse=True)
def no_dotenv(monkeypatch):
    # Keep a developer's real .env out of the tests.
    monkeypatch.setattr(agent, "load_dotenv", lambda: None)


def test_missing_api_key_shows_friendly_error(monkeypatch, capsys):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert agent.main(["hello"]) == 2
    err = capsys.readouterr().err
    assert "ANTHROPIC_API_KEY is not set" in err
    assert ".env.example" in err
    assert "Traceback" not in err


def test_blank_api_key_counts_as_missing(monkeypatch, capsys):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")
    assert agent.main(["hello"]) == 2
    assert "not set" in capsys.readouterr().err


def test_builds_real_client_when_key_present(monkeypatch, capsys):
    made = {}

    class FakeAnthropic(ScriptedClient):
        def __init__(self, api_key):
            super().__init__([final("hi there")])
            made["key"] = api_key

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(agent.anthropic, "Anthropic", FakeAnthropic)
    assert agent.main(["hello"]) == 0
    assert made["key"] == "sk-test"
    assert "hi there" in capsys.readouterr().out


def test_prints_answer_and_summary(capsys):
    client = ScriptedClient([
        tool_turn(("t", "calculator", {"expression": "2+2"})),
        final("Four."),
    ])
    assert agent.main(["what", "is", "2+2?"], client=client) == 0
    out = capsys.readouterr().out
    assert "Four." in out
    assert "Steps: 2 | Tools used: calculator x1 | Tokens: 240 (200 in, 40 out)" in out
    assert client.requests[0]["messages"][0]["content"] == "what is 2+2?"


def test_no_tools_summary_says_none(capsys):
    assert agent.main(["hi"], client=ScriptedClient([final("hello")])) == 0
    assert "Tools used: none" in capsys.readouterr().out


def test_trace_flag_prints_every_step(capsys):
    client = ScriptedClient([
        tool_turn(("t", "calculator", {"expression": "86.4*0.18"}), input_tokens=300, output_tokens=40),
        final("Tip is 15.55", input_tokens=350, output_tokens=15),
    ])
    assert agent.main(["--trace", "tip?"], client=client) == 0
    out = capsys.readouterr().out
    assert "[step 1] model requested 1 tool call(s) (tokens: 300 in, 40 out)" in out
    assert '-> calculator {"expression": "86.4*0.18"}' in out
    assert "result: 15.552" in out
    assert "[step 2] final answer (tokens: 350 in, 15 out)" in out
    assert "Steps: 2" in out


def test_no_trace_output_without_flag(capsys):
    client = ScriptedClient([tool_turn(("t", "calculator", {"expression": "1+1"})), final("2")])
    agent.main(["q"], client=client)
    out = capsys.readouterr().out
    assert "[step" not in out and "->" not in out


def test_step_limit_gives_nonzero_exit_and_message(capsys):
    client = ScriptedClient([tool_turn((str(i), "calculator", {"expression": "1"})) for i in range(5)])
    assert agent.main(["--max-steps", "3", "loop"], client=client) == 1
    out = capsys.readouterr().out
    assert "Stopped after 3 steps" in out
    assert "Steps: 3" in out


@pytest.mark.parametrize("argv", [["--max-steps", "0", "q"], ["--max-steps", "-2", "q"]])
def test_invalid_max_steps(argv, capsys):
    assert agent.main(argv, client=ScriptedClient([])) == 2
    assert "at least 1" in capsys.readouterr().err


def test_blank_question_rejected(capsys):
    assert agent.main(["   "], client=ScriptedClient([])) == 2
    assert "provide a question" in capsys.readouterr().err


def test_no_question_is_an_argparse_error():
    with pytest.raises(SystemExit) as exc:
        agent.main([], client=ScriptedClient([]))
    assert exc.value.code == 2


def test_model_flag_and_env_override(monkeypatch):
    client = ScriptedClient([final("a"), final("b"), final("c")])
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    agent.main(["q"], client=client)
    monkeypatch.setenv("ANTHROPIC_MODEL", "env-model")
    agent.main(["q"], client=client)
    agent.main(["--model", "flag-model", "q"], client=client)
    assert [r["model"] for r in client.requests] == [agent.DEFAULT_MODEL, "env-model", "flag-model"]


def _status_error(cls, status):
    # A bare stand-in for the HTTP response keeps this test independent of the SDK's HTTP library.
    fake_response = SimpleNamespace(status_code=status, headers={}, request=SimpleNamespace())
    return cls("nope", response=fake_response, body=None)


class RaisingClient:
    def __init__(self, exc):
        def create(**kwargs):
            raise exc

        self.messages = type("M", (), {"create": staticmethod(create)})


def test_bad_key_gives_friendly_error(capsys):
    client = RaisingClient(_status_error(anthropic.AuthenticationError, 401))
    assert agent.main(["q"], client=client) == 1
    err = capsys.readouterr().err
    assert "rejected your key" in err and "Traceback" not in err


def test_other_api_errors_are_reported_not_raised(capsys):
    client = RaisingClient(_status_error(anthropic.InternalServerError, 500))
    assert agent.main(["q"], client=client) == 1
    assert "Anthropic API error" in capsys.readouterr().err


def test_format_summary_sorts_tools():
    res = AgentResult(answer="", steps=3, tools_used=Counter({"read_file": 2, "calculator": 1}),
                      input_tokens=1200, output_tokens=34)
    assert agent.format_summary(res) == (
        "Steps: 3 | Tools used: calculator x1, read_file x2 | Tokens: 1,234 (1,200 in, 34 out)"
    )
