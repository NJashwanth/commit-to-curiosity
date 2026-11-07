"""The agent loop: call Claude, run tool_use blocks, feed results back, repeat."""
import json
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import date

from errors import ToolError
from registry import execute_tool, tool_schemas

DEFAULT_MODEL = "claude-haiku-5-5"
MAX_STEPS = 8
MAX_RETRIES = 3
MAX_TOKENS = 1024
PREVIEW_CHARS = 200


def system_prompt():
    return (
        f"You are a small, careful assistant with tools. Today is {date.today().isoformat()}. "
        "Use the calculator for any arithmetic, get_weather for weather, and the file tools for "
        "files in the workspace folder. Call several tools in one turn when they are independent. "
        "If a tool returns an error, read it and either fix the call or explain the problem. "
        "Give a short, direct final answer once you have what you need."
    )


@dataclass
class AgentResult:
    answer: str
    steps: int = 0
    tools_used: Counter = field(default_factory=Counter)
    input_tokens: int = 0
    output_tokens: int = 0
    hit_step_limit: bool = False

    @property
    def total_tokens(self):
        return self.input_tokens + self.output_tokens


def _preview(text, limit=PREVIEW_CHARS):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit] + "..."


def _block_to_param(block):
    """Turn a response block into a plain dict that is safe to send back as history."""
    if block.type == "tool_use":
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    return {"type": "text", "text": block.text}


def run_tool(name, tool_input, execute=execute_tool, max_retries=MAX_RETRIES, retry_delay=0.5, sleep=time.sleep):
    """Run one tool. Returns (text, is_error). Never raises: errors go back to the model as results.

    Transient failures are retried up to `max_retries` times. Permanent ones (bad input, unknown
    city, path traversal) are not, because trying the same call again cannot change the outcome.
    """
    attempt = 0
    while True:
        try:
            return execute(name, tool_input), False
        except Exception as exc:  # noqa: BLE001 - a tool must never crash the loop
            permanent = isinstance(exc, ToolError) and not exc.retryable
            if permanent or attempt >= max_retries:
                note = f" (gave up after {attempt + 1} attempts)" if attempt else ""
                return f"Error: {exc}{note}", True
            attempt += 1
            sleep(retry_delay * attempt)


def run_agent(question, client, model=DEFAULT_MODEL, max_steps=MAX_STEPS, execute=execute_tool,
              tools=None, trace=None, max_retries=MAX_RETRIES, retry_delay=0.5, sleep=time.sleep):
    """Answer `question`, letting Claude call tools until it stops asking for them.

    One step is one model call. `trace` is an optional callable that receives printable lines.
    """
    tools = tool_schemas() if tools is None else tools
    say = trace or (lambda line: None)
    messages = [{"role": "user", "content": question}]
    result = AgentResult(answer="")

    for step in range(1, max_steps + 1):
        response = client.messages.create(
            model=model, max_tokens=MAX_TOKENS, system=system_prompt(), tools=tools, messages=messages,
        )
        result.steps = step
        result.input_tokens += response.usage.input_tokens
        result.output_tokens += response.usage.output_tokens
        usage = f"tokens: {response.usage.input_tokens} in, {response.usage.output_tokens} out"
        text = "".join(b.text for b in response.content if b.type == "text").strip()
        calls = [b for b in response.content if b.type == "tool_use"]

        if response.stop_reason != "tool_use" or not calls:
            result.answer = text or "(the model returned no text)"
            if response.stop_reason == "max_tokens":
                result.answer += "\n[answer was cut off by the token limit]"
            say(f"[step {step}] final answer ({usage})")
            return result

        say(f"[step {step}] model requested {len(calls)} tool call(s) ({usage})")
        if text:
            say(f"  says: {_preview(text)}")
        if step == max_steps:
            break  # no model call left to read the results, so do not run the tools

        messages.append({"role": "assistant", "content": [_block_to_param(b) for b in response.content]})
        tool_results = []
        for call in calls:
            result.tools_used[call.name] += 1
            say(f"  -> {call.name} {json.dumps(call.input)}")
            output, is_error = run_tool(call.name, call.input, execute, max_retries, retry_delay, sleep)
            say(f"     {'ERROR' if is_error else 'result'}: {_preview(output)}")
            block = {"type": "tool_result", "tool_use_id": call.id, "content": output}
            if is_error:
                block["is_error"] = True
            tool_results.append(block)
        messages.append({"role": "user", "content": tool_results})

    result.hit_step_limit = True
    result.answer = (
        f"Stopped after {max_steps} steps without reaching a final answer. "
        "The question may be too open ended, or a tool keeps failing. Try a narrower question."
    )
    say(f"[limit] stopped after {max_steps} steps")
    return result
