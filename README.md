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
| 007 | [tiny-gpt](day-007-tiny-gpt/) | Python, PyTorch, matplotlib | Yes | A character-level GPT built from scratch with hand-written causal attention and trained on CPU in about 8 minutes; it cuts validation loss from 2.48 (bigram baseline) to 1.70 and writes Shakespeare-ish text with temperature and top-k sampling. |
| 008 | [chip8-emu](day-008-chip8-emu/) | TypeScript, Vite, Canvas, Web Audio, vitest | No | A CHIP-8 emulator that runs in the browser: all 35 opcodes, quirk presets for VIP, Octo and SUPER-CHIP, 60Hz timers independent of CPU speed, touch keys, sound and a step debugger with disassembly, plus a hand-written demo ROM and 329 tests. |
| 009 | [connect4-ai](day-009-connect4-ai/) | Python, bitboards, Textual, pytest | Yes | Connect Four on two 64-bit bitboards with three AIs (random, alpha-beta minimax with a transposition table and iterative deepening, and UCB1 MCTS), a Textual TUI with drop animation, hints, undo and live AI stats, and a 100-game Elo arena where MCTS edged minimax 18-15. |
| 010 | [bpe-tokenizer](day-010-bpe-tokenizer/) | Rust, fancy-regex, clap, serde, proptest | Yes | A byte-level BPE tokenizer like GPT-2/GPT-4's with train, encode, decode, colour viz and stats commands: it learns 3,839 merges on tinyshakespeare in 0.09s behind GPT-4 regex pre-tokenization, keeps `<\|endoftext\|>` whole, round-trips any UTF-8 (property tested), and reaches 3.59 bytes/token at 4,096 tokens while Telugu still costs one token per byte. |
| 011 | [tiny-vectordb](day-011-tiny-vectordb/) | Go (standard library only), HNSW, net/http, CRC-32C | Yes | A vector database from scratch with no dependencies: an HNSW index with the paper's neighbor heuristic, string ids and JSON metadata filters applied inside the graph search, tombstone deletes with graph repair, checksummed binary snapshots and an HTTP API; on 50,000 128-d vectors it reaches 0.9997 recall@10 at 11x the speed of brute force (34x at 0.86 recall). |
| 012 | [mini-git](day-012-mini-git/) | Python (standard library only), zlib, SHA-1, difflib, pytest | No | Git rebuilt from scratch with init, add, commit, log, status, diff, branch, checkout and cat-file, byte-compatible with real Git: identical object ids, a binary index v2 that `git status` reads, `.gitignore` support, colored diffs that match `git diff`, and a checkout that refuses to clobber uncommitted work; 133 tests use the real git binary as the oracle and `git fsck --strict` passes on its commits. |
| 013 | [autograd-playground](day-013-autograd-playground/) | TypeScript, Vite, Canvas, inline SVG, vitest | Yes | A scalar autograd engine and tiny neural net library from scratch (Value graph, chain rule, MLP, MSE/hinge/BCE, L2, SGD and Adam) with a browser playground that trains live on seeded moons, circles, XOR and spiral data with a decision-boundary heatmap and loss/accuracy charts, plus a computation graph viewer that draws data and grad for expressions like `tanh(a*b + c)`; every dataset reaches 100% at its default noise (the spiral by step 337) and 216 tests grad-check every op against finite differences. |
| 014 | [ray-tracer](day-014-ray-tracer/) | Rust, rayon, rand_pcg, png, serde + toml, clap, indicatif | No | A path tracer from scratch: spheres with matte, fuzzy metal and glass materials (Snell's law, total internal reflection, Schlick), a thin-lens camera with depth of field, a BVH split on the longest axis, rows rendered in parallel with rayon behind a progress bar, and TOML scenes including a hand-built "J"; the BVH renders the 482-sphere field 6.5x faster (16.8 s vs 108.8 s at 1200x675, 200 spp), the same seed gives a byte-identical PNG on any thread count, and 118 tests check the BVH against brute force on 10,000 seeded rays. |
| 015 | [snake-rl](day-015-snake-rl/) | Python, PyTorch (CPU), NumPy, Pillow, rich, matplotlib, pytest | Yes | A Snake environment with a gym-style API, seeded rules and optional reward shaping, plus a random baseline, tabular Q-learning over an 11-feature state and a DQN (replay buffer, target network, Huber loss); both learners go from a random mean of 0.12 to about 20 apples per game on 12x12 (Q-learning 20.4, DQN 20.9 over 200 greedy episodes, a tie within noise), with CSV logs, best checkpoints, learning curves, GIF replays via Pillow, a live rich terminal mode and 83 tests at 99% coverage. |
| 016 | [tiny-sqlite](day-016-tiny-sqlite/) | Go (standard library only) | No | A small relational database from scratch: a hand-written SQL lexer and recursive-descent parser, a pager with 4096-byte pages and a page cache, one on-disk B+tree per table (splits, linked leaves, range scans), a schema catalog in page 1, and BEGIN/COMMIT/ROLLBACK through a rollback journal that restores the last committed state after a crash at any step of COMMIT; 10,000 rows load in about 0.1 s, a primary key lookup takes well under a millisecond against about 3 ms for a full scan, 91.8% coverage, and 34 queries are compared against `sqlite3` when it is installed. |
| 017 | [evolve-cars](day-017-evolve-cars/) | | | |
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
