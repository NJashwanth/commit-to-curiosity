import pytest

from conftest import ScriptedClient, final, response, text_block, tool_turn
from errors import ToolError
from loop import AgentResult, run_agent, run_tool

NO_SLEEP = dict(sleep=lambda s: None)


def fake_execute(outputs):
    """Build an execute() that records calls and returns/raises from a name -> value map."""
    calls = []

    def execute(name, tool_input):
        calls.append((name, tool_input))
        value = outputs[name]
        if isinstance(value, Exception):
            raise value
        return value(tool_input) if callable(value) else value

    execute.calls = calls
    return execute


def test_direct_answer_with_no_tools():
    client = ScriptedClient([final("Paris.")])
    out = run_agent("Capital of France?", client)
    assert out.answer == "Paris."
    assert out.steps == 1
    assert not out.tools_used
    assert out.total_tokens == 120
    assert len(client.requests) == 1
    req = client.requests[0]
    assert req["messages"] == [{"role": "user", "content": "Capital of France?"}]
    assert {t["name"] for t in req["tools"]} >= {"calculator", "get_weather"}
    assert "Today is" in req["system"]


def test_single_tool_call_then_answer():
    client = ScriptedClient([
        tool_turn(("t1", "calculator", {"expression": "86.4 * 0.18"})),
        final("The tip is $15.55."),
    ])
    out = run_agent("tip?", client)  # uses the real calculator through the real registry
    assert out.answer == "The tip is $15.55."
    assert out.steps == 2
    assert dict(out.tools_used) == {"calculator": 1}
    second = client.requests[1]["messages"]
    assert [m["role"] for m in second] == ["user", "assistant", "user"]
    assert second[1]["content"] == [
        {"type": "tool_use", "id": "t1", "name": "calculator", "input": {"expression": "86.4 * 0.18"}}
    ]
    assert second[2]["content"] == [{"type": "tool_result", "tool_use_id": "t1", "content": "15.552"}]


def test_multiple_tool_calls_in_one_turn_share_one_result_message():
    execute = fake_execute({"calculator": "15.55", "get_weather": '{"rain": 20}'})
    client = ScriptedClient([
        tool_turn(("a", "calculator", {"expression": "1"}), ("b", "get_weather", {"city": "Detroit"}),
                  text="Checking both."),
        final("Done."),
    ])
    out = run_agent("two things", client, execute=execute)
    assert out.steps == 2
    assert [c[0] for c in execute.calls] == ["calculator", "get_weather"]
    results = client.requests[1]["messages"][2]["content"]
    assert [r["tool_use_id"] for r in results] == ["a", "b"]
    assert [r["content"] for r in results] == ["15.55", '{"rain": 20}']
    # The assistant turn keeps its text block and both tool_use blocks, in order.
    assert [b["type"] for b in client.requests[1]["messages"][1]["content"]] == ["text", "tool_use", "tool_use"]


def test_chained_calls_across_turns_feed_earlier_results_forward():
    execute = fake_execute({
        "list_files": "notes.md\nbudget.csv",
        "read_file": lambda i: "total: 5" if i["path"] == "budget.csv" else "?",
        "calculator": "10",
    })
    client = ScriptedClient([
        tool_turn(("1", "list_files", {})),
        tool_turn(("2", "read_file", {"path": "budget.csv"})),
        tool_turn(("3", "calculator", {"expression": "5 * 2"})),
        final("Doubled total is 10."),
    ])
    out = run_agent("chain", client, execute=execute)
    assert out.steps == 4
    assert dict(out.tools_used) == {"list_files": 1, "read_file": 1, "calculator": 1}
    assert out.input_tokens == 400 and out.output_tokens == 80
    # The last request carries the whole history: user, then three assistant/user pairs.
    assert len(client.requests[3]["messages"]) == 7
    assert client.requests[3]["messages"][4]["content"][0]["content"] == "total: 5"


def test_step_limit_stops_a_looping_agent_with_a_clear_message():
    execute = fake_execute({"calculator": "2"})
    client = ScriptedClient([tool_turn((str(i), "calculator", {"expression": "1+1"})) for i in range(20)])
    lines = []
    out = run_agent("loop forever", client, max_steps=8, execute=execute, trace=lines.append)
    assert out.hit_step_limit is True
    assert out.steps == 8
    assert len(client.requests) == 8
    assert "Stopped after 8 steps" in out.answer
    # The 8th request's tool calls are not executed, since the model never sees the results.
    assert len(execute.calls) == 7
    assert any("[limit]" in line for line in lines)


def test_default_step_limit_is_eight():
    client = ScriptedClient([tool_turn((str(i), "calculator", {"expression": "1"})) for i in range(20)])
    out = run_agent("x", client, execute=fake_execute({"calculator": "1"}))
    assert out.steps == 8


def test_tool_exception_becomes_error_result_and_loop_continues():
    execute = fake_execute({"read_file": ToolError("No such file: nope.md")})
    client = ScriptedClient([
        tool_turn(("e1", "read_file", {"path": "nope.md"})),
        final("That file does not exist."),
    ])
    out = run_agent("read nope", client, execute=execute)
    assert out.answer == "That file does not exist."
    block = client.requests[1]["messages"][2]["content"][0]
    assert block["is_error"] is True
    assert block["content"] == "Error: No such file: nope.md"
    assert len(execute.calls) == 1  # permanent error, no retries


def test_unexpected_exception_does_not_crash_the_loop():
    execute = fake_execute({"calculator": RuntimeError("boom")})
    client = ScriptedClient([tool_turn(("c", "calculator", {"expression": "1"})), final("ok")])
    out = run_agent("q", client, execute=execute, **NO_SLEEP)
    assert out.answer == "ok"
    block = client.requests[1]["messages"][2]["content"][0]
    assert block["is_error"] is True and "boom" in block["content"]
    assert len(execute.calls) == 4  # first try plus 3 retries


def test_unknown_tool_name_is_reported_back_to_the_model():
    client = ScriptedClient([tool_turn(("u", "teleport", {})), final("I cannot do that.")])
    out = run_agent("q", client)
    block = client.requests[1]["messages"][2]["content"][0]
    assert block["is_error"] is True and "Unknown tool" in block["content"]
    assert out.answer == "I cannot do that."


def test_run_tool_retries_transient_failures_then_succeeds():
    attempts = []

    def flaky(name, tool_input):
        attempts.append(1)
        if len(attempts) < 3:
            raise ToolError("network blip", retryable=True)
        return "finally"

    sleeps = []
    assert run_tool("t", {}, flaky, sleep=sleeps.append) == ("finally", False)
    assert len(attempts) == 3
    assert sleeps == [0.5, 1.0]


def test_run_tool_gives_up_after_three_retries():
    attempts = []

    def always_down(name, tool_input):
        attempts.append(1)
        raise ToolError("down", retryable=True)

    text, is_error = run_tool("t", {}, always_down, **NO_SLEEP)
    assert is_error is True
    assert len(attempts) == 4
    assert "gave up after 4 attempts" in text and "down" in text


def test_run_tool_does_not_retry_permanent_errors():
    attempts = []

    def bad_input(name, tool_input):
        attempts.append(1)
        raise ToolError("bad input")

    assert run_tool("t", {}, bad_input, **NO_SLEEP) == ("Error: bad input", True)
    assert len(attempts) == 1


def test_custom_retry_count_is_respected():
    attempts = []

    def down(name, tool_input):
        attempts.append(1)
        raise ToolError("down", retryable=True)

    run_tool("t", {}, down, max_retries=1, **NO_SLEEP)
    assert len(attempts) == 2


def test_max_tokens_stop_adds_a_note():
    client = ScriptedClient([response([text_block("partial answ")], "max_tokens")])
    out = run_agent("q", client)
    assert out.answer.startswith("partial answ") and "cut off" in out.answer


def test_empty_final_text_gets_placeholder():
    client = ScriptedClient([response([], "end_turn")])
    assert run_agent("q", client).answer == "(the model returned no text)"


def test_tool_use_stop_reason_without_tool_blocks_is_treated_as_final():
    client = ScriptedClient([response([text_block("hm")], "tool_use")])
    assert run_agent("q", client).answer == "hm"


def test_trace_lines_show_tool_input_result_preview_and_tokens():
    execute = fake_execute({"read_file": "x" * 500, "calculator": ToolError("nope")})
    client = ScriptedClient([
        tool_turn(("a", "read_file", {"path": "big.txt"}), ("b", "calculator", {"expression": "1"}),
                  text="Looking.", input_tokens=11, output_tokens=7),
        final("done", input_tokens=5, output_tokens=2),
    ])
    lines = []
    run_agent("q", client, execute=execute, trace=lines.append)
    joined = "\n".join(lines)
    assert "[step 1] model requested 2 tool call(s) (tokens: 11 in, 7 out)" in joined
    assert "says: Looking." in joined
    assert '-> read_file {"path": "big.txt"}' in joined
    assert "result: " + "x" * 200 + "..." in joined  # preview is truncated
    assert "ERROR: Error: nope" in joined
    assert "[step 2] final answer (tokens: 5 in, 2 out)" in joined


def test_model_and_tools_are_passed_through():
    client = ScriptedClient([final("hi")])
    run_agent("q", client, model="some-model", tools=[{"name": "only"}])
    assert client.requests[0]["model"] == "some-model"
    assert client.requests[0]["tools"] == [{"name": "only"}]


def test_agent_result_total_tokens():
    assert AgentResult(answer="", input_tokens=3, output_tokens=4).total_tokens == 7
