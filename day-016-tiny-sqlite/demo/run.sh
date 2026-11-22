#!/usr/bin/env bash
# Build tinysql, load 10,000 seeded rows, then run demo/queries.sql with the
# input echoed, so the output reads like a terminal session.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

(cd "$root" && go build -o "$tmp/tinysql" ./cmd/tinysql && go build -o "$tmp/seed" ./cmd/seed)
cd "$tmp"

echo '$ seed -rows 10000 | tinysql demo.db'
start=$(date +%s%N)
./seed -rows 10000 | ./tinysql demo.db > /dev/null
end=$(date +%s%N)
echo "loaded 10,000 rows in one transaction: $(( (end - start) / 1000000 )) ms (including process start)"
echo
echo '$ tinysql demo.db'
./tinysql -echo demo.db < "$root/demo/queries.sql"
