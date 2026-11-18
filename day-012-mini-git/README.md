# Day 012: mini-git

**Date:** 2026-11-18

## What it does

mini-git is Git rewritten in about 2,400 lines of standard-library Python. It covers `init`, `add`, `commit`, `log`, `status`, `diff`, `branch`, `checkout`, `cat-file` and `hash-object`, and everything it writes to `.git` is byte-compatible with real Git. Its object ids match `git hash-object`, real `git status` reads its index, and `git fsck --strict` passes on its commits. It works the other way round too: mini-git can pick up a repository that real Git created and keep working in it.

## Why I built it

I use Git every day but had never looked at what `git commit` actually writes. I wanted to know whether it's really just "zlib-compressed files named by their SHA-1", and how much more is needed before the real `git` binary treats your files as its own. It turned out to be more than that. The index is a binary format with stat caching and padding rules, trees sort their entries in an odd order, and checkout needs a careful two-tree merge so it never destroys uncommitted work.

## Tech used

- Python 3.10+, standard library only: `zlib`, `hashlib` (SHA-1), `struct` (index format), `difflib` (hunks), `argparse`
- pytest and pytest-cov for the tests, with the real `git` binary as the oracle (133 tests, 98% coverage)

## How to run

```bash
cd day-012-mini-git
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt     # only for the tests; mini-git has no dependencies

python -m minigit init
python -m minigit add file.txt src/
python -m minigit commit -m "first commit"
python -m minigit log                   # or: log --oneline, log -n 5, log feature
python -m minigit status                # or: status -s, status --porcelain
python -m minigit diff                  # working tree vs index
python -m minigit diff --staged         # index vs HEAD
python -m minigit branch feature && python -m minigit checkout feature
python -m minigit checkout -b topic     # create and switch
python -m minigit cat-file -p <sha>     # also -t, -s, -e; short prefixes and HEAD~2 work
python -m minigit hash-object -w file.txt

scripts/check.sh                        # full test suite with coverage (fails under 85%)
scripts/demo.sh                         # the end-to-end demo below, in a temp folder
```

Plumbing that the tests and demo also use: `ls-files [--stage]`, `write-tree`, `rev-parse [--abbrev-ref]`.

The author comes from `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (and the `COMMITTER` versions), then `user.name` / `user.email` in `.git/config`, then `~/.gitconfig` or `~/.config/git/config`. If none of those are set it falls back to `Jashwanth Neela`. `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` accept `<unix> <+hhmm>` or ISO 8601. Otherwise the date is the current time in the local timezone.

## What's inside .git

This is the repository from the demo below, with the ids it really produced. Tree and blob ids depend only on content, so `588596f` is the same on every run. Commit ids include a timestamp, so they change from run to run.

```text
 .git/HEAD
 "ref: refs/heads/main"          (symbolic: HEAD follows a branch)
      │
      ▼
 .git/refs/heads/main            .git/refs/heads/feature
 "fd4df02..."                    "a345389..."
      │                               │
      ▼                               ▼
 ┌──────────────────────────┐   ┌───────────────────────────────┐
 │ commit fd4df02           │   │ commit a345389                │
 │ tree   588596f           │   │ tree   ...                    │
 │ parent 9026e61 ──────────┼─┐ │ parent 9026e61 ───────────────┼─┐
 │ author Jashwanth Neela   │ │ │ "Add shout and clamp helpers" │ │
 │ "Describe the project"   │ │ └───────────────────────────────┘ │
 └────────────┬─────────────┘ │                                   │
              │ tree          └────────────►  commit 9026e61  ◄───┘
              ▼                               tree 9850a73
 ┌──────────────────────────────────┐         parent 67c11f0 ──► commit 67c11f0
 │ tree 588596f                     │         (root commit: no parent)
 │ 100644 blob 397b4a7  .gitignore  │
 │ 100644 blob a13a758  README.md   │
 │ 040000 tree 1f3b5c0  docs ───────┼──► tree 1f3b5c0
 │ 040000 tree 6eb6648  src  ───┐   │      100644 blob f760292  guide.md
 └──────────────────────────────┼───┘
                                └────► tree 6eb6648
                                         100644 blob 58c3f4c  app.py
                                                   │
                                                   ▼
                       blob 58c3f4c = zlib("blob 94\0def greet(name):\n ...")
                       stored at .git/objects/58/c3f4c...
```

- **Refs point to commits.** A branch is a 41-byte text file holding a commit id. `HEAD` normally holds `ref: refs/heads/<branch>`, so committing moves that branch. Write an id into `HEAD` directly and you have a detached HEAD.
- **Commits point to one tree and their parents.** A commit is a short text object: `tree`, `parent` lines, `author` and `committer` (name, email, Unix time, `+hhmm` offset), a blank line, then the message.
- **Trees point to blobs and subtrees.** Each entry is `<mode> <name>\0<20 raw id bytes>`. Directories use mode `40000` with no leading zero, and they sort as if their name ended in `/`, so `a.txt` comes before the directory `a/`, which comes before `a0`. Get the order wrong and the tree id stops matching Git's.
- **Blobs are just file bytes.** They have no name or permissions, because those live in the tree. Unchanged files are shared: `9026e61` and `fd4df02` both point at the same `src` tree `6eb6648`.
- **Every object** is stored as `zlib("<type> <size>\0" + content)`, and its id is the SHA-1 of the uncompressed bytes.
- **The index** (`.git/index`) is the staging area. It holds a `DIRC` header, then one entry per file with ten 32-bit `lstat` fields (ctime, mtime, dev, inode, mode, uid, gid, size), the blob id, a flags field, and the path padded with 1 to 8 NULs to a multiple of 8 bytes. A SHA-1 of the whole file goes at the end. The stat fields let Git and mini-git skip hashing files that haven't changed. If they're wrong, real `git status` either rehashes everything or misses changes.

## Demo

`scripts/demo.sh` runs this in a fresh temp folder, with an empty `HOME` so the default identity is used, and then lets the real `git` binary check the result:

```text
$ mkdir -p src docs

$ printf '# demo\n' > README.md

$ printf 'def greet(name):\n    return f"hello, {name}"\n' > src/app.py

$ printf '*.log\n' > .gitignore

$ echo noise > debug.log

$ minigit init
Initialized empty Git repository in /tmp/tmp.XXXX/demo/.git/

$ minigit add .

$ minigit status
On branch main

No commits yet

Changes to be committed:
  (use "minigit rm --cached <file>..." to unstage)
	new file:   .gitignore
	new file:   README.md
	new file:   src/app.py


$ minigit commit -m "Initial commit"
[main (root-commit) 67c11f0] Initial commit

$ printf 'def greet(name):\n    return f"hello, {name}!"\n\n\ndef farewell(name):\n    return f"bye, {name}"\n' > src/app.py

$ printf 'Run src/app.py\n' > docs/guide.md

$ minigit add src docs

$ minigit commit -m "Add farewell and a guide"
[main 9026e61] Add farewell and a guide

$ minigit log --oneline
9026e61 (HEAD -> main) Add farewell and a guide
67c11f0 Initial commit

$ minigit branch feature

$ minigit checkout feature
Switched to branch 'feature'

$ minigit branch
* feature
  main

$ printf 'def greet(name):\n    return f"hello, {name}!"\n\n\ndef farewell(name):\n    return f"bye, {name}"\n\n\ndef shout(text):\n    return text.upper()\n' > src/app.py

$ printf 'def clamp(x, lo, hi):\n    return max(lo, min(x, hi))\n' > src/util.py

$ minigit status
On branch feature

Changes not staged for commit:
  (use "minigit add <file>..." to update what will be committed)
  (use "minigit checkout -- <file>..." to discard changes in working directory)
	modified:   src/app.py

Untracked files:
  (use "minigit add <file>..." to include in what will be committed)
	src/util.py

no changes added to commit (use "minigit add" and/or "minigit commit -a")

$ minigit diff --color=never
diff --git a/src/app.py b/src/app.py
index 58c3f4c..f800fd3 100644
--- a/src/app.py
+++ b/src/app.py
@@ -4,3 +4,7 @@ def greet(name):
 
 def farewell(name):
     return f"bye, {name}"
+
+
+def shout(text):
+    return text.upper()

$ minigit add src

$ minigit diff --staged --color=never
diff --git a/src/app.py b/src/app.py
index 58c3f4c..f800fd3 100644
--- a/src/app.py
+++ b/src/app.py
@@ -4,3 +4,7 @@ def greet(name):
 
 def farewell(name):
     return f"bye, {name}"
+
+
+def shout(text):
+    return text.upper()
diff --git a/src/util.py b/src/util.py
new file mode 100644
index 0000000..9bdf08c
--- /dev/null
+++ b/src/util.py
@@ -0,0 +1,2 @@
+def clamp(x, lo, hi):
+    return max(lo, min(x, hi))

$ minigit commit -m "Add shout and clamp helpers"
[feature a345389] Add shout and clamp helpers

$ minigit checkout main
Switched to branch 'main'

$ ls src
app.py

$ printf '# demo\n\nA tiny project managed by mini-git.\n' > README.md

$ minigit commit -a -m "Describe the project"
[main fd4df02] Describe the project

$ minigit log
commit fd4df02a98fdb7540c0836f0fb40162bb50377e6 (HEAD -> main)
Author: Jashwanth Neela <NJashwanth@users.noreply.github.com>
Date:   Wed Nov 18 18:44:07 2026 -0500

    Describe the project

commit 9026e619a650d8f73d855e0bfc9ed40c17632e11
Author: Jashwanth Neela <NJashwanth@users.noreply.github.com>
Date:   Wed Nov 18 18:44:07 2026 -0500

    Add farewell and a guide

commit 67c11f0b95bd30e5d1978cd49ac4bff25f4d1c17
Author: Jashwanth Neela <NJashwanth@users.noreply.github.com>
Date:   Wed Nov 18 18:44:07 2026 -0500

    Initial commit

$ minigit cat-file -p HEAD
tree 588596f19b63352c66cefcd4f35b5d0f62c83e3c
parent 9026e619a650d8f73d855e0bfc9ed40c17632e11
author Jashwanth Neela <NJashwanth@users.noreply.github.com> 1795045447 -0500
committer Jashwanth Neela <NJashwanth@users.noreply.github.com> 1795045447 -0500

Describe the project

# ---- verification with the real git binary ----

$ git log --oneline --graph --all
* a345389 Add shout and clamp helpers
| * fd4df02 Describe the project
|/  
* 9026e61 Add farewell and a guide
* 67c11f0 Initial commit

$ git fsck --full --strict
(no output: every object and link checks out)

$ git status
On branch main
nothing to commit, working tree clean
```

Real `git log --graph` draws the fork between `main` and `feature`, `git fsck --full --strict` finds nothing wrong, and real `git status` agrees that the tree is clean.

## How compatibility is tested

Each test builds a repository in `tmp_path`, runs mini-git in-process so coverage can see it, and runs the real `git` binary as the reference:

- Blob, tree and commit ids equal `git hash-object`, `git mktree` and `git commit-tree` for empty, binary, unicode and 100 KB files and for awkward tree orderings.
- `git cat-file -p` reads every object mini-git writes, and mini-git's `cat-file` output for objects real Git wrote is byte-identical to Git's.
- The index round-trips. `git ls-files --stage` and `git status --porcelain -z` accept mini-git's index, mini-git reads Git's index (including the `TREE` extension, which it drops when rewriting because it would be stale), and an index Git wrote parses and re-serializes byte for byte.
- `git log` and `git fsck --strict --full` pass after mini-git commits, including on top of history Git made with `pack-refs`.
- Fixtures cover nested directories, empty files, binary files, the executable bit, symlinks, unicode and space-containing names, and paths longer than 4,095 bytes.
- `.gitignore`: `add .` in twin repositories produces the same `ls-files` as real Git, and the matcher agrees with `git check-ignore`. The rules tested include globs, `**`, anchored and directory-only patterns, negation, nested `.gitignore` files, `info/exclude` and escaped characters.
- `status --porcelain` equals real Git's output for staged and unstaged adds, modifies, deletes, type changes and mode changes, plus untracked files and collapsed untracked directories.
- `diff` and `diff --staged` equal `git diff`, colors included, for function-context headers, `\ No newline at end of file`, binary files, mode changes, new and deleted files and empty files. A randomized multi-file edit round-trips through `git apply`.
- Checkout refuses to clobber unstaged edits, staged edits, staged removals and untracked files, and leaves the repository untouched when it refuses. It carries unrelated edits over to the new branch, removes and restores files, prunes emptied directories, handles directory↔file and symlink↔file swaps, and real `git status` reports the result as clean.
- Short SHA ambiguity gives Git's error and hint lines listing the candidates. Unknown objects give `fatal: Not a valid object name`.

## Files

| File | What it holds |
|------|---------------|
| `minigit/objects.py` | Object store (read, write, short-id resolution, abbreviation), tree and commit formats, `write_tree` and `flatten_tree` |
| `minigit/index.py` | Index v2 parse and serialize, stat caching, racy-git check, `index.lock` |
| `minigit/refs.py` | Loose and packed refs, symbolic HEAD, branches, revision parsing (`HEAD~2^`, prefixes) |
| `minigit/ignore.py` | `.gitignore` rule parsing and glob→regex translation |
| `minigit/worktree.py` | Working-tree walk, file hashing, "is this file modified?" |
| `minigit/config.py` | Git config parser, identity lookup, date parsing |
| `minigit/diff.py` | Unified diff in Git's format (headers, hunks, funcname context, colors) |
| `minigit/commands/` | One module per command group: `plumbing`, `add`, `commit`, `log`, `status`, `diff`, `branch` |
| `minigit/cli.py` | `argparse` entry point; `GitError` becomes `fatal: ...` plus an exit code |
| `scripts/check.sh`, `scripts/demo.sh` | Tests with coverage, and the end-to-end demo |

## Limitations

- Only loose objects are supported. Objects inside packfiles (after `git gc` or a clone) can't be read.
- There's no merge, rebase, stash, remotes, tags (they are displayed but not created), or `restore`.
- Hunks come from `difflib` instead of Myers. They match Git for ordinary edits, and on tangled edits they may pick different but equally valid hunks.
- Index versions 2 and 3 can be read, and version 2 is written. Version 4 (path compression) is refused with a clear error.

## What I learned

- Git's object model really is that small. Blob, tree and commit are about 150 lines including parsing, and the SHA-1 of `"blob 0\0"` is the famous `e69de29...`.
- Byte compatibility depends on small details. Directories use mode `40000` with no leading zero, trees sort as if directory names end in `/`, index entries are padded with 1 to 8 NULs (never 0), and the name-length field saturates at `0xFFF`.
- The index is a cache as much as a staging area. Its stat data is what makes `git status` fast. A file modified in the same second the index was written is "racy" and has to be rehashed, because its mtime can't prove it hasn't changed.
- Checkout is a merge. The safe rule only touches paths that differ between the two trees. For those, it refuses if the index or working copy differs from `HEAD`, unless they already equal the target. Untracked files in the way are an error, but ignored files can be overwritten.
- Git's porcelain output has rules of its own. Short status quotes names containing spaces while the long format doesn't. `diff` adds a tab after `---`/`+++` names with spaces so `patch` can find where the name ends. Log decorations are listed in reverse refname order.
- With real `git` as the oracle, each "is this right?" became a byte comparison.

## Ideas to extend

- Read packfiles and `.idx` indexes, then write them (`gc`).
- A three-way `merge` with conflict markers, and `stash`.
- Myers diff, to match Git's hunks on every input.
- `restore` and `reset`, and annotated tag creation.
- A `clone` over the smart HTTP protocol.

## Author

**Jashwanth Neela** · [GitHub](https://github.com/NJashwanth)
