#!/usr/bin/env bash
# Put a training text at data/shakespeare.txt. The data/ folder is not committed.
#
# Order of preference:
#   1. Day 7's cached copy of tinyshakespeare (day-007-tiny-gpt/data/input.txt)
#   2. A fresh download of tinyshakespeare (about 1.1 MB) from GitHub
#   3. Day 7's bundled public domain excerpts (about 5 KB), so it works offline
set -euo pipefail
cd "$(dirname "$0")/.."

url="https://raw.githubusercontent.com/karpathy/char-rnn/master/data/tinyshakespeare/input.txt"
out="data/shakespeare.txt"
day7="../day-007-tiny-gpt"

mkdir -p data
if [ -s "$out" ]; then
  echo "$out already exists ($(wc -c < "$out" | tr -d ' ') bytes)"
  exit 0
fi

if [ -s "$day7/data/input.txt" ]; then
  cp "$day7/data/input.txt" "$out"
  echo "copied Day 7's tinyshakespeare to $out"
  exit 0
fi

if curl -fsSL --max-time 30 "$url" -o "$out.tmp" && [ "$(wc -c < "$out.tmp")" -gt 100000 ]; then
  mv "$out.tmp" "$out"
  echo "downloaded tinyshakespeare to $out ($(wc -c < "$out" | tr -d ' ') bytes)"
  exit 0
fi
rm -f "$out.tmp"

cp "$day7/assets/fallback.txt" "$out"
echo "download failed; using Day 7's bundled public domain excerpts (small, so large vocab sizes will stop early)" >&2
