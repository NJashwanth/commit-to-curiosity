# Day 010: bpe-tokenizer

**Date:** 2026-11-15

## What it does

A byte-level BPE tokenizer in Rust, built the same way as GPT-2 and GPT-4's. It learns merges from a text file, encodes text to token ids and decodes them back, keeps special tokens like `<|endoftext|>` whole, and has two inspection commands: `viz` colours every token in the terminal, and `stats` reports compression, vocab usage and encode speed.

```
$ bpe viz --vocab vocabs/v4096-split.json --no-color "To be, or not to be, that is the question:"
[To][ be][,][ or][ not][ to][ be][,][ that][ is][ the][ question][:]

405 308 44 532 325 291 308 44 327 328 268 3490 58

42 bytes -> 13 tokens (3.23 bytes/token)
```

## Why I built it

On Day 7 my tiny GPT read Shakespeare one character at a time. Real models don't: they read tokens, and the tokenizer decides what a model can "see". I wanted to know what is actually inside a tiktoken-style tokenizer. Why do tokens start with a space? Why do other languages cost more tokens than English? And what does the regex at the front of GPT-4's tokenizer actually do?

## How BPE works

Start with one token per byte (ids 0 to 255), so any input can be represented. Then repeat: count every adjacent pair, merge the most frequent pair into a new token, and replace it everywhere. Here are three merges on the classic example `aaabdaaabac`:

```
start      a  a  a  b  d  a  a  a  b  a  c                    11 tokens
           pair counts: aa=4  ab=2  bd=1  da=1  ba=1  ac=1
           best: aa (4)
                 │
merge 1    aa → 256
           [aa] a  b  d [aa] a  b  a  c                        9 tokens
           pair counts: (aa,a)=2  ab=2  bd=1  (d,aa)=1  ba=1  ac=1
           tie at 2: break it by the smaller pair, (97,98) < (256,97)
           best: ab (2)
                 │
merge 2    ab → 257
           [aa][ab] d [aa][ab] a  c                            7 tokens
           pair counts: (aa,ab)=2  (ab,d)=1  (d,aa)=1  (ab,a)=1  ac=1
           best: (aa,ab) (2)
                 │
merge 3    (256, 257) → 258 = "aaab"
           [aaab] d [aaab] a  c                                5 tokens
```

The vocab is the 256 bytes plus the ordered list of merges. To **encode** new text, replay the merges in the order they were learned: always merge the adjacent pair that was learned earliest, until no learned pair is left. To **decode**, concatenate each token's bytes and read the result as UTF-8.

GPT-2 and GPT-4 add one step in front. A regex first splits the text into words, numbers, punctuation and whitespace (`" world"`, `"'ll"`, `"123"`, `"!!!"`), and pairs are only counted inside a piece. Without that step, BPE happily learns tokens like `"e, that "` that glue the end of one word to the start of the next.

## Tech used

- Rust 2024, no ML libraries
- [fancy-regex](https://crates.io/crates/fancy-regex) for the GPT-2 and GPT-4 split patterns (they need lookahead)
- clap (CLI), serde and serde_json (vocab files), indicatif (progress bar)
- proptest for property tests, cargo-llvm-cov for coverage

```
src/
  vocab.rs        ids ↔ bytes, merge ranks, special tokens, JSON save/load
  bpe.rs          training (incremental pair counts + heap) and encode/decode
  pretokenize.rs  GPT-2 / GPT-4 split regexes and special-token splitting
  cli.rs          train, encode, decode, viz, stats
scripts/
  fetch-data.sh   gets tinyshakespeare into data/ (not committed)
  experiments.sh  regenerates results/stats.md and results/viz.md
```

## How to run

```bash
cd day-010-bpe-tokenizer
./scripts/fetch-data.sh    # Day 7's copy if present, else download, else Day 7's 5 KB fallback

cargo run --release -- train --input data/shakespeare.txt --vocab-size 1024 --out vocab.json
cargo run --release -- encode --vocab vocab.json "To be, or not to be"
cargo run --release -- decode --vocab vocab.json 405 308 44 532 325 291 308
cargo run --release -- viz --vocab vocab.json "Hello 👋 నమస్తే world"
cargo run --release -- stats --vocab vocab.json --input data/shakespeare.txt
```

Useful flags:

- `train --no-split` turns pre-tokenization off, to compare.
- `train --pattern gpt2` uses GPT-2's split pattern instead of GPT-4's.
- `train --special TOKEN` (repeatable) or `--no-special`. The default is `<|endoftext|>`.
- `encode --no-special` treats special token strings as plain text.
- `viz --no-color` marks tokens with brackets instead of colours.

`encode` and `decode` read stdin when no text or ids are given, so they pipe into each other:

```bash
echo -n "To be, or not to be" | bpe encode --vocab vocab.json | bpe decode --vocab vocab.json
```

Tests and coverage:

```bash
cargo test
cargo llvm-cov --summary-only
./scripts/experiments.sh   # all six vocabs, stats and viz
```

## Results

All six vocabs were trained on tinyshakespeare (1,115,394 bytes) on an Apple M2. "split" is GPT-4 pre-tokenization, the default, and "no-split" is `--no-split`. The bytes/token and usage columns are measured on the training text. The held-out column trains on the first 90% of lines and measures on the last 10%. Full output for each vocab is in [results/stats.md](results/stats.md).

| vocab | mode | tokens | bytes/token | held-out bytes/token | vocab used | encode MB/s |
|------:|------|-------:|------------:|---------------------:|-----------:|------------:|
| 512 | split | 547,756 | 2.04 | 1.99 | 62.3% | 13.8 |
| 512 | no-split | 568,689 | 1.96 | 1.94 | 62.3% | 6.8 |
| 1024 | split | 428,271 | 2.60 | 2.45 | 79.2% | 13.9 |
| 1024 | no-split | 443,864 | 2.51 | 2.40 | 79.7% | 4.8 |
| 4096 | split | 310,498 | 3.59 | 3.29 | 89.0% | 13.7 |
| 4096 | no-split | 295,670 | 3.77 | 3.39 | 91.1% | 4.0 |

Training is quick. Pre-tokenized, the text becomes 15,258 distinct chunks and 3,839 merges take 0.09 s. Without the split it is one 1.1 MB sequence and takes 0.3 s.

What the numbers say:

- **At 512 and 1024 tokens, pre-tokenization compresses better**, on the training text and on held-out text.
- **At 4096, no-split wins on bytes/token, but by memorising the file's layout.** Its longest tokens are speaker headers like `".\n\nKING RICHARD III:\n"` (21 bytes) and `".\n\nHENRY BOLINGBROKE:\n"`. The split vocab's longest are words: `" Northumberland"`, `" Bolingbroke"`, `" countenance"`. No-split also loses more on held-out text (3.77 → 3.39, against 3.59 → 3.29), and it produces cuts like `[b][e, that ]`.
- **Not every token gets used.** 9% to 38% of the vocab never appears in the final encoding. These are stepping-stone merges like `"GLOUCES"`, which existed only to build `"GLOUCESTER"` and occur 0 times once the longer token exists.
- **Encode speed stays flat with the split** (about 14 MB/s), because each distinct word is encoded once and cached. Without it, the whole file is a single chunk, so it gets slower as the vocab grows (6.8 → 4.0 MB/s).

### Viz

The same Shakespeare line at different vocab sizes (from [results/viz.md](results/viz.md)):

```
512 split     [To][ be][,][ ][or][ not][ to][ be][,][ that][ is][ the][ ][qu][est][ion][:]   17 tokens
1024 split    [To][ be][,][ or][ not][ to][ be][,][ that][ is][ the][ qu][est][ion][:]       15 tokens
4096 split    [To][ be][,][ or][ not][ to][ be][,][ that][ is][ the][ question][:]           13 tokens
4096 no-split [To ][be, ][or ][not to ][b][e, that ][is the ][quest][ion][:]                  10 tokens
```

The mixed line, with the 1024-token vocab:

```
[H][ell][o][ ][\xF0][\x9F][\x91][\x8B][ ][\xE0][\xB0][\xA8][\xE0][\xB0][\xAE][\xE0][\xB0][\xB8][\xE0][\xB1][\x8D][\xE0][\xB0][\xA4][\xE0][\xB1][\x87][ world]

72 415 111 32 240 159 145 139 32 224 176 168 224 176 174 224 176 184 224 177 141 224 176 164 224 177 135 878

35 bytes -> 28 tokens (1.25 bytes/token)
\xNN = one byte of a character that is split across tokens
```

`" world"` is one token. The 4 bytes of 👋 and the 18 bytes of నమస్తే stay single bytes at every vocab size, because there is no Telugu or emoji in Shakespeare. A model using this tokenizer would spend 18 tokens on one Telugu word and 1 on an English one. That is the "token tax" on non-English text, here at its most extreme. In a terminal, each token gets its own background colour instead of brackets.

### Tests

There are 84 tests: 74 unit tests, 3 that run the real binary, and 7 property tests with 300 cases each. Coverage with cargo-llvm-cov is 99.6% of lines and 99.4% of regions. Key checks:

- Training on `aaabdaaabac` gives exactly the three merges above.
- The incremental trainer matches a naive "recount everything" trainer on 400 random corpora, and the heap encoder matches a naive "apply every merge in order" encoder.
- `decode(encode(s)) == s` for arbitrary UTF-8 (proptest), plus ASCII, emoji, ZWJ sequences, Telugu, mixed scripts, empty and whitespace-only strings.
- Tokens never cross pre-token boundaries, and special tokens are never split.
- Save then load gives identical encodings.
- Unknown ids give a clear error.

## What I learned

- Keeping pair counts up to date incrementally is where the bugs live. My first version learned one merge too many on a random input. A pair can appear and then vanish again within a single merge pass, so it got pushed onto the heap with a count of 0, and a 0 that matches its own stale entry looks "valid". Comparing against a naive trainer on hundreds of random inputs found it in seconds.
- Ties happen right away. In the classic example, `(aa, a)` and `(a, b)` both have count 2 after the first merge. Breaking ties by the smaller pair reproduces the textbook result and makes training deterministic. Rust's `HashMap` iterates in a different order on every run, so without an explicit rule the output would change between runs.
- Encoding with a min-heap works because every pair a merge creates contains the new token, so its rank is always higher than the merge that made it. Popping the lowest rank, leftmost first, gives exactly the same result as the textbook "merge everything in rank order".
- Special tokens have to be cut out of the training text. Otherwise `<|endoftext|>` repeated a few thousand times would train merges like `"<|"` and `"|>"`, and the "special" token would no longer be special.
- GPT-4's split regex is built for Latin script. Telugu vowel signs and the virama are Unicode marks (`\p{M}`), not letters, so `నమస్తే` splits into `నమస` + `్త` + `ే`, cutting through what readers see as a single syllable. Newer patterns (o200k) include `\p{M}` in the letter class for this reason.
- Byte-level BPE makes round-tripping trivial, but decoding is only safe on whole encodings. Slice the ids in the middle of an emoji and the bytes are no longer valid UTF-8, which is why `decode` returns a `lossy` flag and the CLI prints a warning.

## Ideas to extend

- Add the o200k split pattern and train on a multilingual corpus, to see how much the Telugu token tax drops.
- Load OpenAI's published cl100k ranks and check this encoder matches tiktoken id for id.
- Speed up pre-tokenization with a hand-written splitter instead of a backtracking regex.
- Parallel training and encoding over chunks with rayon.
- In `viz`, group the bytes of a split character so it shows as one glyph spanning several colours.

## Author

**Jashwanth Neela** · [GitHub](https://github.com/NJashwanth)
