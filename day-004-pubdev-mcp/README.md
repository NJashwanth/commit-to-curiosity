# Day 004: pubdev-mcp

**Date:** 2026-11-08

## What it does

An MCP server that gives Claude live access to [pub.dev](https://pub.dev). Claude can search packages, read a package's details and score, compare 2 to 5 packages side by side with a health verdict (active, stale, discontinued), and list everything a publisher owns. It also ships one prompt, `pick_package`, that walks Claude through search, compare and recommend.

| Tool | What you get |
|------|--------------|
| `search_packages(query, limit=10)` | name, description, latest version, likes, pub points, 30 day downloads |
| `package_info(name)` | latest version, publisher, SDK constraints, platforms, repo and homepage links, last published date |
| `package_score(name)` | pub points with per-area breakdown, likes, downloads, flags (null safe, Dart 3 compatible, wasm ready, discontinued) |
| `compare_packages(names)` | 2 to 5 packages side by side, with a verdict and the reason for it |
| `publisher_packages(publisher)` | packages owned by a verified publisher, e.g. `jneela.dev` |

Prompt: `pick_package(use_case)`.

Unknown packages or publishers, timeouts, 5xx responses and bad input come back as `{"error": "..."}` with a readable message, never as an exception, so Claude can read the problem and carry on.

## Why I built it

Every Claude connector is an MCP server, and I had never built one. I also pick Flutter packages constantly, and doing it by hand means opening six pub.dev tabs. This was a chance to learn the protocol by building the thing I would actually use.

## Tech used

- Python 3.12+
- Official [`mcp` SDK](https://github.com/modelcontextprotocol/python-sdk), `FastMCP`, stdio transport (pinned `<2`, see "What I learned")
- `httpx` (async, 10 second timeout) against the public pub.dev JSON API
- `pytest`, `pytest-cov`, `httpx.MockTransport` (no network in tests)

## How MCP works here

```
 You: "compare dio and http"
        |
        v
 +-------------------+   1. initialize + tools/list     +----------------------+
 |  Claude Code or   | ------------------------------>  |  pubdev-mcp          |
 |  Claude Desktop   |      (JSON-RPC over stdio:       |  (server.py, a child |
 |  (MCP client)     |       stdin / stdout)            |   process it spawned)|
 |                   | <------------------------------  |                      |
 |  Claude (model)   |   tool names + JSON schemas      |  FastMCP registry:   |
 |  decides to call  |                                  |   5 tools, 1 prompt  |
 |  compare_packages |   2. tools/call                  |                      |
 |                   | ------------------------------>  |  tools.py            |
 +-------------------+   compare_packages(dio, http)    |    |                 |
        ^                                               |    v                 |
        |                                               |  client.py + cache   |
        |   3. result (compact JSON)                    |    |  10 min TTL     |
        +<-------------------------------               |    v                 |
                                                        +----|-----------------+
                                                             | HTTPS (httpx)
                                                             v
                                                        pub.dev /api/...
```

1. The client launches `server.py` as a child process and talks JSON-RPC over its stdin and stdout. That is the whole stdio transport. Anything the server prints to stdout would corrupt the stream, so logs go to stderr.
2. On startup the client asks `tools/list` and `prompts/list`. FastMCP builds each tool's JSON schema from the Python type hints and docstring, and that schema is all the model sees of the tool.
3. When you ask a question, the model decides which tool to call and fills in the arguments. The client sends `tools/call`, the server runs the function and returns JSON, and the model reads it and writes the answer.
4. The server is the only code that talks to pub.dev. The model never gets network access of its own, just these five tools.

## How to run

```bash
cd day-004-pubdev-mcp
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

**Claude Code**

```bash
claude mcp add pubdev -- "$PWD/.venv/bin/python" "$PWD/server.py"
claude mcp list          # pubdev: ... Connected
```

Then ask in a Claude Code session: "best state management package for Flutter" or run the prompt `/mcp__pubdev__pick_package`.

**Claude Desktop**

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), use absolute paths, then restart the app:

```json
{
  "mcpServers": {
    "pubdev": {
      "command": "/absolute/path/to/day-004-pubdev-mcp/.venv/bin/python",
      "args": ["/absolute/path/to/day-004-pubdev-mcp/server.py"]
    }
  }
}
```

On Windows use `.venv\Scripts\python.exe` for the command.

**MCP Inspector** (to poke at the tools without a model)

```bash
npx @modelcontextprotocol/inspector .venv/bin/python server.py
# or headless:
npx @modelcontextprotocol/inspector --cli .venv/bin/python server.py --method tools/list
npx @modelcontextprotocol/inspector --cli .venv/bin/python server.py \
  --method tools/call --tool-name package_info --tool-arg name=dio
```

**Tests**

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest          # 89 tests, ~99% coverage, no network
```

CI (`.github/workflows/day-004-tests.yml`) runs the suite on every change to this folder and fails under 85% coverage.

## Demo output

Real runs against live pub.dev on 2026-11-08. First the raw tool results through the MCP Inspector, then what Claude Code wrote using the same server.

### 1. "best state management package for Flutter"

`search_packages(query="state management", limit=5)`:

```json
{
  "query": "state management",
  "count": 5,
  "results": [
    {"name": "state_management", "description": "A Flutter package to manage state in a simple and efficient way, offering both synchronous and asynchronous state updates.", "latest_version": "0.0.1", "likes": 0, "pub_points": "140/160", "downloads_30d": 10},
    {"name": "riverpod", "description": "A reactive caching and data-binding framework. Riverpod makes working with asynchronous code a breeze.", "latest_version": "3.5.0", "likes": 4043, "pub_points": "160/160", "downloads_30d": 4381982},
    {"name": "flutter_bloc", "description": "Flutter widgets that make it easy to implement the BLoC (Business Logic Component) design pattern. Built to be used with the bloc state management package.", "latest_version": "9.1.1", "likes": 8089, "pub_points": "160/160", "downloads_30d": 2283225},
    {"name": "bloc", "description": "A predictable state management library that helps implement the BLoC (Business Logic Component) design pattern.", "latest_version": "9.2.1", "likes": 3223, "pub_points": "160/160", "downloads_30d": 2440129},
    {"name": "bloc_test", "description": "A testing library which makes it easy to test blocs. Built to be used with the bloc state management package.", "latest_version": "10.0.0", "likes": 669, "pub_points": "160/160", "downloads_30d": 1482603}
  ]
}
```

Claude Code, using the server (`claude -p`):

> **Recommendation: Riverpod (`flutter_riverpod`).**
>
> Data from pub.dev:
>
> | Package | Downloads (30d) | Likes | Pub points | Last published |
> |---|---|---|---|---|
> | flutter_riverpod | 4.27M | 2.9k | 140/160 | 1 day ago (active) |
> | flutter_bloc | 2.28M | 8.1k | 160/160 | 555 days ago (stale) |
> | provider | 1.21M | 11k | 150/160 | 445 days ago (stale) |
> | get | 0.79M | 15.6k | 140/160 | 348 days ago (active) |
> | mobx | 0.12M | 1.3k | 160/160 | 57 days ago (active) |
>
> Riverpod has the most downloads and the freshest release.
>
> - **flutter_bloc:** a solid choice for strict, event-driven structure.
> - **provider:** its release cadence has slowed.
> - **get:** its high likes don't match its downloads.
>
> Caveat: `flutter_riverpod` lists no web platform in this data, though the plain `riverpod` package may differ. Check that if you target web.

### 2. "compare dio and http"

`compare_packages(names=["dio", "http"])`:

```json
{
  "packages": [
    {"name": "dio", "latest_version": "5.11.1", "last_published": "2026-09-04", "days_since_publish": 65, "pub_points": "160/160", "likes": 8373, "downloads_30d": 5424731, "null_safe": true, "dart3_compatible": true, "platforms": ["android", "ios", "linux", "macos", "web", "windows"], "verdict": "active", "verdict_reason": "published 65 days ago, 160/160 pub points"},
    {"name": "http", "latest_version": "1.6.0", "last_published": "2025-11-10", "days_since_publish": 362, "pub_points": "160/160", "likes": 8481, "downloads_30d": 14803040, "null_safe": true, "dart3_compatible": true, "platforms": ["android", "ios", "linux", "macos", "web", "windows"], "verdict": "active", "verdict_reason": "published 362 days ago, 160/160 pub points"}
  ],
  "leaders": {"pub_points": "dio", "likes": "http", "downloads_30d": "http"},
  "verdict_rules": "discontinued = flagged on pub.dev; stale = last publish over 365 days ago, or over 180 days with under 50% of pub points; otherwise active"
}
```

Claude Code:

> **dio 5.11.1 vs http 1.6.0** (from pub.dev):
>
> | | dio | http |
> |---|---|---|
> | Last published | 2026-09-04 (65 days ago) | 2025-11-10 (362 days ago) |
> | Pub points | 160/160 | 160/160 |
> | Likes | 8,373 | 8,481 |
> | Downloads (30d) | 5.4M | 14.8M |
> | Platforms | all six | all six |
> | Verdict | active | active |
>
> Both are null-safe, Dart 3 compatible and healthy. http is more popular and slightly more liked. dio is updated more recently. http is close to the 365-day "stale" cutoff.
>
> The tool doesn't report features. From general knowledge, dio adds interceptors, cancellation and uploads. http is simpler and lighter.

### 3. "list packages by jneela.dev"

`publisher_packages(publisher="jneela.dev")`:

```json
{
  "publisher": "jneela.dev",
  "website": "https://jneela.dev/",
  "package_count": 5,
  "packages": [
    {"name": "genui_mock", "latest_version": "0.1.3", "description": "Record, save, and replay GenUI streaming sessions as deterministic, git-diffable JSON fixtures. Test Catalog widgets against real recorded model output with zero network calls.", "last_published": "2026-10-19", "discontinued": false},
    {"name": "lifecycle_logger", "latest_version": "1.0.1", "description": "Debug-focused Flutter utility for app and widget lifecycle logging.", "last_published": "2026-04-28", "discontinued": false},
    {"name": "feature_flag_audit", "latest_version": "1.3.1", "description": "CLI tool to audit feature flags and Firebase Remote Config usage in Flutter apps.", "last_published": "2026-07-02", "discontinued": false},
    {"name": "broken_glass", "latest_version": "1.0.0", "description": "Break any Flutter widget like a pane of glass \u2014 radial fractures, tumbling shards and lit edges.", "last_published": "2026-09-01", "discontinued": false},
    {"name": "flutter_mock_server", "latest_version": "1.0.2", "description": "A local mock API server for Flutter and Dart with YAML config, static/stateful routes, CRUD simulation, deterministic seeded data, and hot reload.", "last_published": "2026-04-28", "discontinued": false}
  ]
}
```

Claude Code:

> - **genui_mock** 0.1.3: record, save and replay GenUI streaming sessions as JSON fixtures (published 2026-10-19)
> - **lifecycle_logger** 1.0.1: debug-focused Flutter app and widget lifecycle logging (2026-04-28)
> - **feature_flag_audit** 1.3.1: CLI to audit feature flags and Firebase Remote Config usage in Flutter apps (2026-07-02)
> - **broken_glass** 1.0.0: breaks any Flutter widget like a pane of glass, with radial fractures and tumbling shards (2026-09-01)
> - **flutter_mock_server** 1.0.2: local mock API server for Flutter and Dart with YAML config and hot reload (2026-04-28)

### Errors are messages, not crashes

```
package_info(name="nope_zzz")       -> {"error": "Package 'nope_zzz' not found on pub.dev."}
compare_packages(names=["dio"])     -> {"error": "Give at least 2 different package names to compare."}
```

## What I learned

- **MCP is small.** A server is a process that answers `tools/list` and `tools/call` over stdin and stdout. FastMCP turns a typed, documented Python function into a tool with a JSON schema, so the docstring is effectively the prompt that teaches the model when to use it.
- **`mcp` 2.x renamed FastMCP** to `MCPServer` and moved modules, so `requirements.txt` pins `mcp>=1.12,<2`. Moving to 2.x is a small rename job for later.
- **pub.dev's search only returns names.** Every search result needs a package call and a score call, so tools fan out with `asyncio.gather`, and the 10 minute cache makes the second query nearly free.
- **There is no popularity percentage in the public API anymore**, only `downloadCount30Days`, so "popularity" here means 30 day downloads.
- **Pub points breakdown lives in `/api/packages/<name>/metrics`**, not `/score`. `package_score` reads it on a best-effort basis and still works without it.
- **Spawned servers get a stripped environment.** The Inspector does not pass `HTTPS_PROXY` through to the server it launches, so my first run behind a proxy returned the friendly "Could not reach pub.dev" error. Passing it with `-e HTTPS_PROXY=...` fixed it, and it was a nice accidental test of the error path.
- **Verdicts are blunt.** "Stale" means no release in over a year (or over 6 months with under half the pub points). That flags mature, finished packages like `flutter_bloc` and `provider` in demo 1, and `http` sits 3 days from the line in demo 2. Treat the verdict as a prompt to look closer, not a judgement.
- **Search ranking is pub.dev's.** A brand new package with 0 likes can rank first for "state management", which is why `pick_package` has Claude shortlist and compare instead of trusting the first hit.

## Ideas to extend

- Add a `dependency_check` tool that takes a `pubspec.yaml` and flags stale or discontinued dependencies
- Weight the verdict by release cadence over time instead of only the last publish date
- Read the changelog and open issue counts for a package
- Add `sort` options (likes, downloads, recently updated) to `search_packages`
- Publish it so others can `uvx pubdev-mcp`
