#!/usr/bin/env bash
# End-to-end demo in a throwaway folder: mini-git does all the work,
# then the real git binary inspects the result.
#
#   scripts/demo.sh            # uses .venv/bin/python
#   PY=python3 scripts/demo.sh
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
PY=${PY:-"$here/.venv/bin/python"}
[ -x "$PY" ] || PY=python3

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/home" "$work/demo"
cd "$work/demo"

# An empty HOME means no ~/.gitconfig, so mini-git falls back to its default identity.
export HOME="$work/home" GIT_CONFIG_NOSYSTEM=1 PYTHONPATH="$here"
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_AUTHOR_DATE GIT_COMMITTER_DATE

# Echo a command with any multi-word argument in double quotes, then run it.
show() {
  local out="\$" arg
  for arg in "$@"; do
    case "$arg" in *" "*) out+=" \"$arg\"" ;; *) out+=" $arg" ;; esac
  done
  echo "$out"
}
minigit() { show minigit "$@"; "$PY" -m minigit "$@"; echo; }
git() { show git "$@"; command git "$@"; echo; }
run() { echo "\$ $*"; eval "$@"; echo; }

run "mkdir -p src docs"
run "printf '# demo\n' > README.md"
run "printf 'def greet(name):\n    return f\"hello, {name}\"\n' > src/app.py"
run "printf '*.log\n' > .gitignore"
run "echo noise > debug.log"

minigit init
minigit add .
minigit status
minigit commit -m "Initial commit"

run "printf 'def greet(name):\n    return f\"hello, {name}!\"\n\n\ndef farewell(name):\n    return f\"bye, {name}\"\n' > src/app.py"
run "printf 'Run src/app.py\n' > docs/guide.md"
minigit add src docs
minigit commit -m "Add farewell and a guide"
minigit log --oneline

minigit branch feature
minigit checkout feature
minigit branch

run "printf 'def greet(name):\n    return f\"hello, {name}!\"\n\n\ndef farewell(name):\n    return f\"bye, {name}\"\n\n\ndef shout(text):\n    return text.upper()\n' > src/app.py"
run "printf 'def clamp(x, lo, hi):\n    return max(lo, min(x, hi))\n' > src/util.py"
minigit status
minigit diff --color=never
minigit add src
minigit diff --staged --color=never
minigit commit -m "Add shout and clamp helpers"

minigit checkout main
run "ls src"
run "printf '# demo\n\nA tiny project managed by mini-git.\n' > README.md"
minigit commit -a -m "Describe the project"
minigit log
minigit cat-file -p HEAD

echo "# ---- verification with the real git binary ----"
echo
git log --oneline --graph --all
show git fsck --full --strict
command git fsck --full --strict && echo "(no output: every object and link checks out)"
echo
git status
