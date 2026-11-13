# Day 002: ask-my-repo

**Date:** 2026-11-06

## What it does

A command line tool that answers questions about any public GitHub repo. `index` shallow clones a repo, splits its code and docs into chunks, embeds them locally and stores them in ChromaDB. `ask` (or `chat`) finds the 6 most similar chunks for your question. With an `ANTHROPIC_API_KEY` set, Claude answers from only those chunks and cites `path:line-range`. Without a key, or if the Claude call fails, you get the top chunks with their paths and similarity scores. Citations are printed under every answer.

## Why I built it

I wanted to see how much of "chat with a codebase" is plain retrieval. The idea: embeddings find the right few hundred lines, and the LLM only has to read them. It is also a chance to run the same RAG loop for free with a local embedding model, then add Claude on top as an optional last step.

## Tech used

- Python 3
- `sentence-transformers` with `all-MiniLM-L6-v2` (local embeddings, no API cost)
- ChromaDB (persistent, cosine similarity), stored under `.index/<repo-name>/`
- Anthropic Messages API (optional, `claude-haiku-5-5` by default, override with `ANTHROPIC_MODEL`)
- `pytest` and `pytest-cov`

## How to run

```bash
cd day-002-ask-my-repo
pip install -r requirements.txt
cp .env.example .env        # optional: add ANTHROPIC_API_KEY for answers from Claude

python ask.py index https://github.com/NJashwanth/commit-to-curiosity
python ask.py ask "How does new-day.sh find the next day number?"
python ask.py chat          # interactive, type exit to leave
```

The first `index` or `ask` downloads the embedding model (about 90 MB) and caches it. Options: `--repo NAME` picks an indexed repo (default is the most recently indexed one) and `-k N` changes how many chunks are retrieved (default 6). Re-running `index` for the same repo replaces its index.

Files: `ask.py` (CLI), `repo.py` (URL check, shallow clone, file filter), `chunker.py` (chunks with path and line range), `index.py` (embedder and Chroma index), `retrieval.py` (top-k search), `answer.py` (prompt, Claude call, fallback, citations).

What gets indexed: text files up to 200 KB. Skipped: `.git`, `node_modules`, virtualenvs, build output, lockfiles, minified files, binaries and anything that is not valid UTF-8.

## How RAG works here

```
INDEX  (python ask.py index <url>)

  GitHub URL
     |  git clone --depth 1  (temp folder, deleted afterwards)
     v
  files --[skip binaries, lockfiles, node_modules, .git, > 200 KB]--> text files
     |  split at def/class/headings, merge tiny pieces,
     |  ~800 token windows with overlap for big ones
     v
  chunks  (path, start_line, end_line, text)
     |  all-MiniLM-L6-v2, runs locally
     v
  vectors --> ChromaDB  .index/<repo-name>/   (old index replaced)


ASK  (python ask.py ask "<question>")

  question --embed--> vector --cosine similarity--> top 6 chunks
                                                       |
                  prompt = rules + 6 chunks labelled path:start-end + question
                                                       |
                      ANTHROPIC_API_KEY set and the call works?
                          yes |                    | no, or the call fails
                              v                    v
              Claude answers only from the     print the chunks with
              chunks, citing path:start-end    path:start-end and score
                              \                  /
                               v                v
                         "Sources:" list under every answer
```

The model never sees the whole repo, only the 6 chunks. That keeps the call small and cheap, and it is why the answer can only be as good as the retrieval.

## Sample output

**Important: how this was produced.** The sandbox this was built in cannot reach huggingface.co, so `all-MiniLM-L6-v2` could not be downloaded. Everything below is the real CLI (real `git clone` of this repo, real filtering, chunking and ChromaDB index, real retrieval and output formatting) with one swap: the embedder was replaced by a throwaway hashed bag-of-words stand-in. Rankings with the real model will differ, and should be better. There was also no `ANTHROPIC_API_KEY`, so this is fallback mode, and the Claude path has only been exercised with a mocked client. Absolute paths are shortened. The repo was indexed as it was on GitHub before Day 2 was pushed.

```text
$ python ask.py index https://github.com/NJashwanth/commit-to-curiosity
Cloning NJashwanth/commit-to-curiosity (shallow)...
Read 23 files, chunking...
Embedding 79 chunks locally...
Indexed 79 chunks from 23 files into .index/commit-to-curiosity
```

<details>
<summary><code>$ python ask.py ask "How does new-day.sh find the next day number?"</code></summary>

```text
(repo: commit-to-curiosity)

Note: No ANTHROPIC_API_KEY set, showing the top matching chunks.

[1] README.md:15-35  (score 0.340)
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
    
    ... (7 more lines)

[2] day-001-weather-bot/requirements.txt:1-2  (score 0.304)
    requests>=2.31
    python-dotenv>=1.0

[3] new-day.sh:1-55  (score 0.301)
    #!/usr/bin/env bash
    # Scaffold the next day's project folder and add it to the index.
    # Usage: ./new-day.sh <project-name>
    set -euo pipefail
    
    cd "$(dirname "$0")"
    
    if [ $# -lt 1 ] || [ -z "$1" ]; then
      echo "Usage: $0 <project-name>" >&2
      echo "Example: $0 weather-bot" >&2
      exit 1
    fi
    
    # Normalise to kebab-case: lowercase, spaces/underscores to hyphens, drop anything else.
    ... (41 more lines)

[4] README.md:1-6  (score 0.277)
    # commit-to-curiosity
    
    One small, interesting project a day.
    
    I'm learning AI, and I'm building alongside it. Some days the project uses AI, some days it doesn't. Each one starts with a question I wanted answered. The rule is to ship something small every day rather than something perfect once in a while.

[5] day-001-weather-bot/README.md:13-32  (score 0.243)
    ## Tech used
    
    - Python 3, `requests`, `python-dotenv`
    - Open-Meteo geocoding and forecast APIs (no key needed)
    - Anthropic Messages API (optional, `claude-haiku-5-5` by default)
    
    ## How to run
    
    ```bash
    cd day-001-weather-bot
    pip install -r requirements.txt
    cp .env.example .env        # optional: add ANTHROPIC_API_KEY for AI mode
    
    python bot.py "Do I need a jacket in Detroit tomorrow?"
    ... (5 more lines)

[6] .github/workflows/day-001-tests.yml:1-26  (score 0.242)
    name: day-001-tests
    
    on:
      push:
        paths:
          - "day-001-weather-bot/**"
          - ".github/workflows/day-001-tests.yml"
      pull_request:
        paths:
          - "day-001-weather-bot/**"
    
    jobs:
      test:
        runs-on: ubuntu-latest
    ... (12 more lines)

Sources:
  README.md:15-35  score 0.340
  day-001-weather-bot/requirements.txt:1-2  score 0.304
  new-day.sh:1-55  score 0.301
  README.md:1-6  score 0.277
  day-001-weather-bot/README.md:13-32  score 0.243
  .github/workflows/day-001-tests.yml:1-26  score 0.242
```

</details>

<details>
<summary><code>$ python ask.py ask "What does the weather bot do when no API key is set?"</code></summary>

```text
(repo: commit-to-curiosity)

Note: No ANTHROPIC_API_KEY set, showing the top matching chunks.

[1] day-001-weather-bot/bot.py:19-26  (score 0.428)
    def build_parser():
        ap = argparse.ArgumentParser(description="Answer natural weather questions with Open-Meteo.")
        ap.add_argument("question", nargs="*", help='e.g. "Do I need a jacket in Detroit tomorrow?"')
        ap.add_argument("--units", choices=["metric", "imperial"], default="imperial")
        ap.add_argument("--no-ai", action="store_true", help="skip Claude even if ANTHROPIC_API_KEY is set")
        return ap
    

[2] day-001-weather-bot/tests/conftest.py:24-39  (score 0.397)
    def to_api_daily(rows):
        """Open-Meteo returns column-oriented arrays."""
        daily = {"time": [r["time"] for r in rows]}
        for k in DAILY_KEYS:
            daily[k] = [r[k] for r in rows]
        return {"daily": daily}
    
    
    @pytest.fixture(autouse=True)
    def clean_env(monkeypatch):
        """No real key, no real .env file, ever."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
        monkeypatch.setattr("bot.load_dotenv", lambda *a, **k: None)
    ... (1 more lines)

[3] day-001-weather-bot/tests/test_ai.py:13-19  (score 0.391)
    def test_fallback_when_no_api_key(forecast, mocked, capsys):
        assert bot.main(["jacket in Detroit tomorrow"]) == 0
        out = capsys.readouterr().out
        assert "📍 Detroit, Michigan, US" in out
        assert not any(c.request.url == API_URL for c in mocked.calls)
    

[4] day-001-weather-bot/tests/test_ai.py:37-43  (score 0.379)
    def test_no_ai_flag_skips_claude_even_with_key(forecast, mocked, monkeypatch, capsys):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        assert bot.main(["jacket in Detroit tomorrow", "--no-ai"]) == 0
        assert "📍" in capsys.readouterr().out
        assert not any(c.request.url == API_URL for c in mocked.calls)
    

[5] day-001-weather-bot/tests/test_ai.py:27-36  (score 0.376)
    def test_ai_mode_used_when_key_set(forecast, mocked, monkeypatch, capsys):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        mocked.add(responses.POST, API_URL, json=CLAUDE_REPLY)
        assert bot.main(["Do I need a jacket in Detroit tomorrow?"]) == 0
        assert capsys.readouterr().out.strip() == "Bring a light jacket. No umbrella needed."
        call = [c for c in mocked.calls if c.request.url == API_URL][0]
        assert call.request.headers["x-api-key"] == "sk-test"
        assert json.loads(call.request.body)["model"] == DEFAULT_MODEL
    

[6] day-001-weather-bot/README.md:1-8  (score 0.371)
    # Day 001: weather-bot
    
    **Date:** 2026-11-05
    
    ## What it does
    
    A command line weather bot that takes a plain English question, finds the city and time frame in it, pulls the forecast from Open-Meteo, and answers. With an `ANTHROPIC_API_KEY` set, Claude turns the raw forecast into a short, practical answer (what to wear, umbrella or not, best time to go out). Without a key it prints a clean forecast with emoji icons.

Sources:
  day-001-weather-bot/bot.py:19-26  score 0.428
  day-001-weather-bot/tests/conftest.py:24-39  score 0.397
  day-001-weather-bot/tests/test_ai.py:13-19  score 0.391
  day-001-weather-bot/tests/test_ai.py:37-43  score 0.379
  day-001-weather-bot/tests/test_ai.py:27-36  score 0.376
  day-001-weather-bot/README.md:1-8  score 0.371
```

</details>

<details>
<summary><code>$ python ask.py ask "How do the Day 1 tests run in CI and what coverage is required?"</code></summary>

```text
(repo: commit-to-curiosity)

Note: No ANTHROPIC_API_KEY set, showing the top matching chunks.

[1] day-001-weather-bot/.coveragerc:1-3  (score 0.433)
    [run]
    omit =
        tests/*

[2] day-001-weather-bot/tests/test_ai.py:1-12  (score 0.403)
    import json
    
    import pytest
    import requests
    import responses
    
    import bot
    from ai import API_URL, DEFAULT_MODEL, build_prompt, ask_claude
    
    CLAUDE_REPLY = {"content": [{"type": "text", "text": "Bring a light jacket. No umbrella needed."}]}
    

[3] .github/workflows/day-001-tests.yml:1-26  (score 0.358)
    name: day-001-tests
    
    on:
      push:
        paths:
          - "day-001-weather-bot/**"
          - ".github/workflows/day-001-tests.yml"
      pull_request:
        paths:
          - "day-001-weather-bot/**"
    
    jobs:
      test:
        runs-on: ubuntu-latest
    ... (12 more lines)

[4] day-001-weather-bot/tests/test_cli.py:1-13  (score 0.343)
    from datetime import date, timedelta
    
    import pytest
    import responses
    
    import bot
    from weather import FORECAST_URL, GEOCODE_URL
    
    
    def forecast_call(mocked):
        return [c for c in mocked.calls if c.request.url.startswith(FORECAST_URL)][0]
    

[5] day-001-weather-bot/README.md:46-56  (score 0.302)
    ## Running tests
    
    ```bash
    cd day-001-weather-bot
    pip install -r requirements-dev.txt
    python -m pytest                      # runs with coverage, config in pytest.ini
    python -m pytest --cov-fail-under=85  # what CI enforces
    ```
    
    No test touches the network: Open-Meteo and the Claude API are mocked with `responses`, and any unmocked request raises. The suite covers question parsing, the Open-Meteo client (success, unknown city, params, timeouts, 5xx, bad JSON), fallback formatting and day selection, AI mode and its fallback, and the CLI end to end. Currently 76 tests at 99% coverage. GitHub Actions runs them on pushes that touch this folder (`.github/workflows/day-001-tests.yml`).

[6] day-001-weather-bot/tests/test_cli.py:54-64  (score 0.285)
    def test_unknown_city_exits_1(mocked, capsys):
        mocked.add(responses.GET, GEOCODE_URL, json={"results": []})
        assert bot.main(["weather in Zzyzx"]) == 1
        assert "couldn't find a place" in capsys.readouterr().err
    
    
    def test_network_failure_exits_1(mocked, capsys):
        import requests
        mocked.add(responses.GET, GEOCODE_URL, body=requests.exceptions.ConnectionError())
        assert bot.main(["weather in Detroit"]) == 1
        assert "Could not reach" in capsys.readouterr().err

Sources:
  day-001-weather-bot/.coveragerc:1-3  score 0.433
  day-001-weather-bot/tests/test_ai.py:1-12  score 0.403
  .github/workflows/day-001-tests.yml:1-26  score 0.358
  day-001-weather-bot/tests/test_cli.py:1-13  score 0.343
  day-001-weather-bot/README.md:46-56  score 0.302
  day-001-weather-bot/tests/test_cli.py:54-64  score 0.285
```

</details>

Looking at the first answer shows two weak spots worth fixing. The stand-in ranked the `new-day.sh` chunk 3rd, which a real embedding model should improve. And the fallback only previews the first 14 lines of a chunk, so the day-number loop (further down `new-day.sh`) is cut off even though the right chunk was found.

With a key, the same question goes to Claude and the output looks like this (layout only, not captured from a live call):

```text
new-day.sh finds the next number by scanning the existing day-NNN-* folders and taking the
highest one plus one (new-day.sh:1-55) ...

Sources:
  new-day.sh:1-55  score 0.xxx  (cited)
  README.md:15-35  score 0.xxx
  ...
```

## Running tests

```bash
cd day-002-ask-my-repo
pip install -r requirements-dev.txt
python -m pytest                      # runs with coverage, config in pytest.ini
python -m pytest --cov-fail-under=85  # fail if coverage drops under 85%
```

No test touches the network or downloads a model. `git` is mocked, the embedder is replaced by deterministic fake vectors (or a fake `sentence_transformers` module), and the Claude client is a recording stub. ChromaDB itself runs for real in a temp folder. The suite covers file filtering, URL validation, the chunker (line ranges, overlap, empty and single-line files), the index (persistence, replacing on re-index), ranking by similarity, the prompt sent to Claude, fallback without a key and after a Claude failure, and the CLI (index, ask, chat exit, invalid URL, asking before indexing). Currently 240 tests at 100% coverage.

## What I learned

- RAG quality is mostly decided before the LLM: how you cut chunks and which ones come back. Keeping the path and line range on every chunk is what makes real citations possible.
- Splitting on `def`/`class` is easy in Python (`ast`), but a regex for other languages is rough. My first version treated every `# comment` in a shell script as a heading until a test caught it, so headings now only count in markdown files.
- `all-MiniLM-L6-v2` reads at most 256 word pieces, while chunks can be about 800 tokens. Long chunks are only partly embedded, so smaller chunks would likely retrieve better.
- Replacing an index is simplest as "drop the collection, create it again" inside Chroma, instead of deleting folders under a client that may still hold them open. The old index is only dropped once there is something to replace it with.
- Designing for tests changed the shape of the code: the model loads lazily, the embedder and the Claude client are passed in, and the fallback path is a normal return value, not an exception.

## Ideas to extend

- Preview the best matching lines of a chunk in fallback mode instead of the first 14.
- Hybrid search (keyword plus embeddings) and a reranking step.
- Embed in 256 token windows to match the model, and compare retrieval quality.
- Incremental re-index by file hash, other branches, private repos and local folders.
- A `list` command for indexed repos, and multi-turn memory in `chat`.

## Author

**Jashwanth Neela** · [GitHub](https://github.com/NJashwanth)
