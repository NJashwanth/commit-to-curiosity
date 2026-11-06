"""ask-my-repo command line: index, ask, chat.

    python ask.py index https://github.com/<owner>/<repo>
    python ask.py ask "How does the build work?"
    python ask.py chat
"""
import argparse
import os
import sys
import tempfile
from pathlib import Path

from dotenv import load_dotenv

from answer import answer, format_answer
from chunker import chunk_files
from index import (INDEX_ROOT, Embedder, IndexMissingError, build_index, list_indexes,
                   open_index)
from repo import RepoError, clone_repo, iter_repo_files, parse_repo_url
from retrieval import TOP_K, retrieve

EXIT_WORDS = {"exit", "quit", ":q", "q"}


def err(message):
    print(message, file=sys.stderr)


def cmd_index(args):
    try:
        owner, name, clone_url = parse_repo_url(args.url)
    except RepoError as exc:
        err(f"Error: {exc}")
        return 2
    try:
        with tempfile.TemporaryDirectory(prefix="ask-my-repo-") as tmp:
            dest = Path(tmp) / name
            print(f"Cloning {owner}/{name} (shallow)...")
            clone_repo(clone_url, dest)
            files = list(iter_repo_files(dest))
        print(f"Read {len(files)} files, chunking...")
        chunks = chunk_files(files)
        print(f"Embedding {len(chunks)} chunks locally...")
        stored = build_index(name, chunks, Embedder(), source_url=clone_url[:-4], root=INDEX_ROOT)
    except (RepoError, IndexMissingError) as exc:
        err(f"Error: {exc}")
        return 1
    print(f"Indexed {stored} chunks from {len(files)} files into {INDEX_ROOT / name}")
    return 0


def pick_index(repo_name):
    """Collection for --repo, or for the most recently indexed repo. Raises IndexMissingError."""
    if repo_name:
        return repo_name, open_index(repo_name, root=INDEX_ROOT)
    names = list_indexes(INDEX_ROOT)
    if not names:
        raise IndexMissingError("Nothing indexed yet. Run: python ask.py index <github-url>")
    return names[0], open_index(names[0], root=INDEX_ROOT)


def respond(question, collection, embedder, k):
    hits = retrieve(question, collection, embedder, k=k)
    return format_answer(answer(question, hits, api_key=os.getenv("ANTHROPIC_API_KEY")))


def cmd_ask(args):
    question = args.question.strip()
    if not question:
        err("Error: the question is empty.")
        return 2
    try:
        name, collection = pick_index(args.repo)
    except IndexMissingError as exc:
        err(f"Error: {exc}")
        return 1
    print(f"(repo: {name})\n")
    print(respond(question, collection, Embedder(), args.k))
    return 0


def cmd_chat(args):
    try:
        name, collection = pick_index(args.repo)
    except IndexMissingError as exc:
        err(f"Error: {exc}")
        return 1
    embedder = Embedder()
    print(f"Chatting with {name}. Type a question, or 'exit' to leave.")
    while True:
        try:
            question = input("\nask> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not question:
            continue
        if question.lower() in EXIT_WORDS:
            break
        print()
        print(respond(question, collection, embedder, args.k))
    print("Bye.")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="ask.py", description="Ask questions about a GitHub repo.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="clone a GitHub repo and build its local index")
    p_index.add_argument("url", help="https://github.com/<owner>/<repo>")
    p_index.set_defaults(func=cmd_index)

    for name, helptext, func in (("ask", "ask one question", cmd_ask),
                                 ("chat", "interactive question loop", cmd_chat)):
        p = sub.add_parser(name, help=helptext)
        if name == "ask":
            p.add_argument("question")
        p.add_argument("--repo", help="indexed repo name (default: the most recently indexed)")
        p.add_argument("-k", type=int, default=TOP_K, help=f"chunks to retrieve (default {TOP_K})")
        p.set_defaults(func=func)
    return parser


def main(argv=None):
    load_dotenv()
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
