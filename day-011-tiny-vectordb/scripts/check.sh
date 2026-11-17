#!/usr/bin/env bash
# Local pre-commit check: formatting, vet, race-enabled tests and coverage.
# Usage: ./scripts/check.sh
set -euo pipefail
cd "$(dirname "$0")/.."

unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
  echo "gofmt needed on:" >&2
  echo "$unformatted" >&2
  exit 1
fi

go vet ./...
go test -race -count=1 -coverprofile=coverage.out ./...
echo
go tool cover -func=coverage.out | tail -1
