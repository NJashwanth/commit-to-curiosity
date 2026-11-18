"""init, hash-object and cat-file."""

from __future__ import annotations

import sys
from pathlib import Path

from .. import refs
from ..errors import GitError
from ..objects import OBJECT_TYPES, hash_object, parse_tree, validate
from ..output import quote_path, write
from ..repo import DEFAULT_BRANCH, Repository


def register(sub) -> None:
    p = sub.add_parser("init", help="create an empty repository")
    p.add_argument("directory", nargs="?", default=".")
    p.add_argument("-b", "--initial-branch", default=DEFAULT_BRANCH)
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("hash-object", help="compute an object id, optionally writing the object")
    p.add_argument("-t", dest="type", default="blob", choices=OBJECT_TYPES)
    p.add_argument("-w", dest="write", action="store_true", help="write the object into the store")
    p.add_argument("--stdin", action="store_true", help="read the object from standard input")
    p.add_argument("files", nargs="*")
    p.set_defaults(func=cmd_hash_object)

    p = sub.add_parser("cat-file", help="show an object's type, size or content")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("-t", dest="mode", action="store_const", const="type")
    mode.add_argument("-s", dest="mode", action="store_const", const="size")
    mode.add_argument("-p", dest="mode", action="store_const", const="pretty")
    mode.add_argument("-e", dest="mode", action="store_const", const="exists")
    p.add_argument("args", nargs="+", metavar="[<type>] <object>")
    p.set_defaults(func=cmd_cat_file)


def cmd_init(args) -> int:
    repo, existed = Repository.init(args.directory, args.initial_branch)
    verb = "Reinitialized existing" if existed else "Initialized empty"
    write(f"{verb} Git repository in {repo.gitdir}/\n")
    return 0


def cmd_hash_object(args) -> int:
    blobs = []
    if args.stdin:
        blobs.append(sys.stdin.buffer.read())
    for name in args.files:
        try:
            blobs.append(Path(name).read_bytes())
        except OSError as exc:
            raise GitError(f"could not open '{name}' for reading: {exc.strerror}") from None
    repo = Repository.discover() if args.write else None
    for data in blobs:
        validate(args.type, data)
        sha = repo.objects.write(args.type, data) if repo else hash_object(data, args.type)
        write(sha + "\n")
    return 0


def cmd_cat_file(args) -> int:
    repo = Repository.discover()
    if args.mode is None:
        # `cat-file <type> <object>`: print the raw content, checking the type.
        if len(args.args) != 2:
            raise GitError("cat-file: expected <type> <object> or one of -t, -s, -p, -e", code=129, prefix="usage")
        expected, name = args.args
        write(repo.objects.read_type(resolve(repo, name), expected))
        return 0
    if len(args.args) != 1:
        raise GitError("cat-file: too many arguments", code=129, prefix="usage")
    name = args.args[0]
    if args.mode == "exists":
        try:
            resolve(repo, name)
        except GitError:
            return 1
        return 0
    obj_type, data = repo.objects.read(resolve(repo, name))
    if args.mode == "type":
        write(obj_type + "\n")
    elif args.mode == "size":
        write(f"{len(data)}\n")
    elif obj_type == "tree":
        write("".join(f"{e.mode:0>6} {e.type} {e.sha}\t{quote_path(e.name)}\n" for e in parse_tree(data)))
    else:
        write(data)
    return 0


def resolve(repo: Repository, name: str) -> str:
    return refs.resolve_revision(repo, name)
