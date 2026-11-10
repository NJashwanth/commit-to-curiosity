# commit-to-curiosity

One small, interesting project a day.

I'm learning AI, and I'm building alongside it. Some days the project uses AI, some days it doesn't. Each one starts with a question I wanted answered. The rule is to ship something small every day rather than something perfect once in a while.

## Projects

<!-- PROJECTS-START -->
| Day | Project | Tech | AI? | Summary |
|-----|---------|------|-----|---------|
| 001 | [weather-bot](day-001-weather-bot/) | Python, Open-Meteo, Claude API | Yes | Ask weather questions in plain English; Claude gives practical advice, or a clean emoji forecast without an API key. |
| 002 | [ask-my-repo](day-002-ask-my-repo/) | Python, sentence-transformers, ChromaDB, Claude API | Yes | Ask questions about any GitHub repo; local embeddings retrieve the code, Claude answers with path:line citations, or you get the top chunks without a key. |
| 003 | [tiny-agent](day-003-tiny-agent/) | Python, Anthropic tool use API, Open-Meteo | Yes | A from-scratch agent loop with no frameworks: Claude picks from 5 tools (calculator, weather, sandboxed files, notes), sees the results and repeats until it can answer, with step limits, retries and a `--trace` mode. |
| 004 | [pubdev-mcp](day-004-pubdev-mcp/) | Python, MCP SDK (FastMCP), httpx, pub.dev API | Yes | An MCP server that gives Claude live pub.dev access: search packages, check scores, compare up to 5 side by side with an active, stale or discontinued verdict, and list a publisher's packages. Works in Claude Code and Claude Desktop. |
| 005 | [receipt-splitter](day-005-receipt-splitter/) | Python, Claude vision, Pydantic, Pillow | Yes | Snap a receipt and split the bill: Claude vision reads the items, Pydantic validates with one retry, sanity checks flag totals that don't add up, and tax and tip are split proportionally to the exact cent. |
| 006 | [git-wrapped](day-006-git-wrapped/) | | | |
<!-- PROJECTS-END -->

## How it works

Every project lives in its own folder at the repo root:

```
day-001-weather-bot/
day-002-some-other-idea/
...
```

- **Naming:** `day-NNN-project-name`. The day number is 3-digit zero padded, and the project name is lowercase kebab-case.
- **README:** each folder gets a README copied from [`_template/README.md`](_template/README.md), covering what it does, why I built it, the tech used, how to run it, what I learned, and ideas to extend it.
- **Index:** every project gets a row in the table above.

To start a new day:

```bash
./new-day.sh weather-bot
```

This creates the next `day-NNN-weather-bot/` folder, fills the template with the day number, project name and today's date, and adds a row to the index. Afterwards, fill in the Tech, AI? and Summary columns.
