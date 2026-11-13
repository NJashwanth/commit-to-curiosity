# Day 003: tiny-agent

**Date:** 2026-11-07

## What it does

A command line agent with no framework. You ask a question, Claude decides which tools to call, sees the results, and keeps going until it can answer. It has five tools: `calculator`, `get_weather`, `list_files`, `read_file` and `save_note`. With `--trace` it prints every step (tool, input, result preview, tokens), and at the end it always prints total steps, tools used and total tokens.

```bash
python agent.py "What's 18% tip on $86.40, and is it going to rain in Detroit tonight?"
python agent.py "List the files in workspace/ and summarize notes.md"
python agent.py --trace "..."
```

## Why I built it

Day 1 was a single API call and Day 2 was RAG. Every agent framework hides the same thing: a loop. I wanted to write that loop by hand and see how small it really is. It turns out the whole idea fits in one small file (`loop.py`): call the model, run whatever tools it asks for, append the results, call it again.

## Tech used

- Python 3, the official `anthropic` SDK (raw Messages API tool use, no LangChain or agent frameworks)
- Open-Meteo geocoding and forecast APIs (no key needed) via `requests`
- `ast` for the calculator, `pathlib` for the file sandbox
- `claude-haiku-5-5` by default, override with `ANTHROPIC_MODEL` or `--model`
- `pytest` and `pytest-cov`

## How to run

```bash
cd day-003-tiny-agent
pip install -r requirements.txt
cp .env.example .env        # then put your ANTHROPIC_API_KEY in it

python agent.py "What's 18% tip on $86.40, and is it going to rain in Detroit tonight?"
python agent.py --trace "List the files in workspace/ and summarize notes.md"
```

Options: `--trace` prints every step, `--max-steps N` changes the step limit (default 8), `--model NAME` picks a model. Without `ANTHROPIC_API_KEY` it prints a short message explaining how to set one and exits with code 2. Tests need no key and no network:

```bash
pip install -r requirements-dev.txt
python -m pytest --cov-fail-under=85
```

Files: `agent.py` (CLI), `loop.py` (the agent loop, retries, step limit), `registry.py` (tool schemas and dispatch), `calculator.py`, `weather.py`, `files.py` (list_files, read_file, save_note), `errors.py` (`ToolError`), `workspace/` (sample files the file tools may touch).

## The tools

| Tool | What it does | Safety |
|------|--------------|--------|
| `calculator` | `+ - * / // % **` and parentheses | Walks the `ast` and allows only numbers and arithmetic operators. Never `eval`. Imports, names, attribute access and function calls are rejected. Huge exponents and results are capped. |
| `get_weather` | Open-Meteo geocoding, current conditions and a next 24 hours summary (temperature range, chance of rain, every third hour) | Unknown city and network failures become tool errors. Network errors are marked retryable. |
| `list_files` | Lists a folder inside `workspace/` | Rejects `..`, absolute paths and symlinks that point outside. |
| `read_file` | Reads a UTF-8 file inside `workspace/` | Same sandbox. Output is truncated at 20,000 characters. |
| `save_note` | Appends a timestamped bullet to `workspace/notes.md` | The target file is fixed, so the model cannot pick a path. Notes are capped at 2,000 characters. |

## How the agent loop works

```
python agent.py "<question>"
        |
        v
  messages = [ user: question ]
        |
        v
+--> step n  (n <= 8)
|      call Claude with messages + tool schemas
|            |
|            |-- stop_reason is not tool_use --> final answer --> print answer and summary
|            |
|            `-- stop_reason is tool_use
|                  for each tool_use block in the reply:
|                      run the tool
|                        - transient failure: retry up to 3 times
|                        - any error: send it back as a tool_result with is_error = true
|                  messages += [ assistant: the reply ]
|                  messages += [ user: ALL tool_results from that reply, in order ]
|                       |
`-----------------------'   (loop)

  after step 8 with the model still asking for tools:
      stop and print "Stopped after 8 steps without reaching a final answer."
```

The model never runs anything. It only emits `tool_use` blocks (a name and JSON input). The loop is the part that executes them and reports back, and the model sees the full history on every call, which is how it chains one result into the next call.

A few details that matter:

- **One step is one model call.** Several tool calls in the same reply are one step, and their results go back together in one user message, matched by `tool_use_id`.
- **Errors are data.** A failing tool never crashes the loop. The error text goes back with `is_error: true` and Claude can fix its call or explain the problem. Permanent errors (bad input, unknown city, path traversal) are not retried, since the same call cannot succeed. Transient ones (network) are retried up to 3 times with a short backoff.
- **The step limit is a hard stop.** On the last allowed step, requested tools are not executed, because the model would never see the results.
- **Tokens are summed from `response.usage`** on every call, so the final total covers the whole run.

## Sample traces

**Important: how these were produced.** The sandbox this was built in has no `ANTHROPIC_API_KEY` and cannot reach `api.open-meteo.com`, so these are not live Claude runs. What is real: the actual `python agent.py --trace` CLI, the agent loop, the tool registry and every tool (the file tools read the real sample `workspace/`, the calculator computed the results, `save_note` wrote to a real `notes.md`, and the weather parsing ran on a response shaped like Open-Meteo's). What is substituted: Claude was replaced by a scripted model that I wrote to make the tool calls shown, and the Open-Meteo responses were canned, so the Detroit weather is made up. The final answers were written by me, not Claude. Token counts are rough estimates (characters divided by 4) of the real request and response payloads, not API-reported numbers. Run the commands above with your own key to get real traces. The tool-call behaviour of the loop itself (single call, parallel calls, chained calls, step limit, errors and retries) is covered by the test suite with scripted clients.

<details>
<summary><b>1.</b> calculator + get_weather, called in parallel in one turn</summary>

```text
$ python agent.py --trace "What's 18% tip on $86.40, and is it going to rain in Detroit tonight?"
[step 1] model requested 2 tool call(s) (tokens: 579 in, 68 out)
  says: I'll work out the tip and check tonight's forecast.
  -> calculator {"expression": "86.40 * 0.18"}
     result: 15.552
  -> get_weather {"city": "Detroit"}
     result: {"location": "Detroit, Michigan, United States", "units": "imperial", "current": {"time": "2026-11-07T20:30", "temp": "41.4F", "feels_like": "36.8F", "conditions": "overcast", "wind": "9.1 mph"}, "nex...
[step 2] final answer (tokens: 995 in, 61 out)

An 18% tip on $86.40 is $15.55, so the total would be $101.95. Detroit is overcast and 41.4F right now, and rain looks likely tonight: up to a 65% chance, with about 3 rainy hours in the next 24. Bring an umbrella.

Steps: 2 | Tools used: calculator x1, get_weather x1 | Tokens: 1,703 (1,574 in, 129 out)
```

</details>

<details>
<summary><b>2.</b> list_files then read_file, chained across turns</summary>

```text
$ python agent.py --trace "List the files in workspace/ and summarize notes.md"
[step 1] model requested 1 tool call(s) (tokens: 574 in, 18 out)
  -> list_files {}
     result: budget.csv notes.md trip-plan.md
[step 2] model requested 1 tool call(s) (tokens: 635 in, 33 out)
  says: Now the notes.
  -> read_file {"path": "notes.md"}
     result: # Notes - 2026-11-02: Try the new ramen place on Woodward before the weekend. - 2026-11-03: Dentist appointment moved to Thursday at 9:30. - 2026-11-04: Renew the car registration, due by the 20th. - ...
[step 3] final answer (tokens: 769 in, 83 out)

workspace/ has notes.md, budget.csv and trip-plan.md. notes.md is a short dated list of four to-dos from Nov 2 to 5: try the new ramen place on Woodward before the weekend, the dentist moved to Thursday at 9:30, renew the car registration by the 20th, and read the tool use chapter in the Anthropic docs.

Steps: 3 | Tools used: list_files x1, read_file x1 | Tokens: 2,112 (1,978 in, 134 out)
```

</details>

<details>
<summary><b>3.</b> read_file, calculator (twice in one turn), then save_note</summary>

```text
$ python agent.py --trace "Add up every expense in budget.csv, work out 15% of that as a savings target, and save the result as a note."
[step 1] model requested 1 tool call(s) (tokens: 589 in, 23 out)
  -> read_file {"path": "budget.csv"}
     result: category,amount rent,1450.00 groceries,412.35 transit,96.50 internet,59.99 dining out,138.20 subscriptions,42.97
[step 2] model requested 2 tool call(s) (tokens: 675 in, 90 out)
  says: Six expenses. I'll add them up and take 15%.
  -> calculator {"expression": "1450.00 + 412.35 + 96.50 + 59.99 + 138.20 + 42.97"}
     result: 2200.01
  -> calculator {"expression": "(1450.00 + 412.35 + 96.50 + 59.99 + 138.20 + 42.97) * 0.15"}
     result: 330.0015
[step 3] model requested 1 tool call(s) (tokens: 819 in, 36 out)
  -> save_note {"text": "Monthly expenses total $2,200.01; 15% savings target is $330.00."}
     result: Saved note to notes.md.
[step 4] final answer (tokens: 895 in, 41 out)

Your expenses in budget.csv total $2,200.01. Setting aside 15% means saving $330.00 (330.0015 exactly). I saved that summary to notes.md.

Steps: 4 | Tools used: calculator x2, read_file x1, save_note x1 | Tokens: 3,168 (2,978 in, 190 out)
```

</details>

## What I learned

- An agent is a `for` loop around one API call. The "intelligence" is the model choosing tool calls. Everything else is bookkeeping: keep the history, run the tools, return results with the right `tool_use_id`.
- Parallel tool use is just several `tool_use` blocks in one reply. You must answer all of them in a single user message, or the API rejects the next call.
- Tool errors are best treated as information for the model, not exceptions for the program. That one decision removes most of the crash handling.
- Retrying only helps for failures that can change. Telling "network blip" apart from "bad input" with a single flag on the exception kept the retry logic tiny.
- Sandboxing file access is about checking the resolved path, not the string. `..` filtering alone misses absolute paths and symlinks.
- A hard step limit is cheap insurance against a looping agent, and the limit needs a clear message so the user knows why it stopped.

## Ideas to extend

- Stream the model's text and tool calls as they happen instead of waiting for each step
- Add prompt caching for the system prompt and tool schemas
- A `web_search` or `http_get` tool, with an allowlist of hosts
- Keep conversation history between questions for a chat mode
- Ask for confirmation before tools that write, like `save_note`
- Token budget limit in addition to the step limit

## Author

**Jashwanth Neela** · [GitHub](https://github.com/NJashwanth)
