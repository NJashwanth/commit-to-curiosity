#!/usr/bin/env bash
# Run the full test suite with coverage. Must pass before every commit.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-.venv/bin/python}
"$PY" -m pytest --cov=minigit --cov-report=term-missing --cov-fail-under=85 "$@"
