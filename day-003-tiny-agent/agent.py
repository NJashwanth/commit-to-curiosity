#!/usr/bin/env python3
"""A tiny tool-using agent, built on the raw Anthropic Messages API.

    python agent.py "What's 18% tip on $86.40, and is it going to rain in Detroit tonight?"
    python agent.py "List the files in workspace/ and summarize notes.md"
    python agent.py --trace "..."   # print every step
"""
import argparse
import os
import sys

import anthropic
from dotenv import load_dotenv

from loop import DEFAULT_MODEL, MAX_STEPS, run_agent

MISSING_KEY_MESSAGE = (
    "ANTHROPIC_API_KEY is not set.\n"
    "Get a key at https://console.anthropic.com/, then either run\n"
    "  export ANTHROPIC_API_KEY=sk-ant-...\n"
    "or copy .env.example to .env and put the key there."
)


def build_parser():
    ap = argparse.ArgumentParser(description="Ask a question; Claude decides which tools to use.")
    ap.add_argument("question", nargs="+", help="what to ask the agent")
    ap.add_argument("--trace", action="store_true", help="print every step: tool, input, result, tokens")
    ap.add_argument("--max-steps", type=int, default=MAX_STEPS, help=f"model calls allowed (default {MAX_STEPS})")
    ap.add_argument("--model", default=None, help=f"override the model (default {DEFAULT_MODEL})")
    return ap


def format_summary(result):
    tools = ", ".join(f"{name} x{n}" for name, n in sorted(result.tools_used.items())) or "none"
    return (
        f"Steps: {result.steps} | Tools used: {tools} | "
        f"Tokens: {result.total_tokens:,} ({result.input_tokens:,} in, {result.output_tokens:,} out)"
    )


def main(argv=None, client=None):
    """Run the CLI. `client` lets tests pass a scripted client. Returns the exit code."""
    load_dotenv()
    args = build_parser().parse_args(argv)
    if args.max_steps < 1:
        print("--max-steps must be at least 1.", file=sys.stderr)
        return 2
    question = " ".join(args.question).strip()
    if not question:
        print("Please provide a question.", file=sys.stderr)
        return 2

    if client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
        if not api_key:
            print(MISSING_KEY_MESSAGE, file=sys.stderr)
            return 2
        client = anthropic.Anthropic(api_key=api_key)

    model = args.model or os.getenv("ANTHROPIC_MODEL") or DEFAULT_MODEL
    trace = print if args.trace else None
    try:
        result = run_agent(question, client, model=model, max_steps=args.max_steps, trace=trace)
    except anthropic.AuthenticationError:
        print("The Anthropic API rejected your key. Check ANTHROPIC_API_KEY.", file=sys.stderr)
        return 1
    except anthropic.APIError as exc:
        print(f"Anthropic API error: {exc}", file=sys.stderr)
        return 1

    if args.trace:
        print()
    print(result.answer)
    print(f"\n{format_summary(result)}")
    return 1 if result.hit_step_limit else 0


if __name__ == "__main__":
    sys.exit(main())
