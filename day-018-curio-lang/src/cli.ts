// Command line entry point:
//   tsx src/cli.ts file.curio     run a program
//   tsx src/cli.ts                start the REPL
//   tsx src/cli.ts -e 'print(1)'  run a snippet

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { CurioRuntimeError, CurioSyntaxError } from "./errors.js";
import { Interpreter } from "./interpreter.js";
import { ReplSession } from "./repl.js";

export const VERSION = "0.1.0";

export const USAGE = `Curio ${VERSION}, a small dynamic language

Usage:
  curio <file.curio>     run a program
  curio                  start the REPL
  curio -e <code>        run a snippet
  curio --help           show this help
  curio --version        show the version

Exit codes: 0 ok, 64 bad usage, 65 syntax error, 66 file not found, 70 runtime error.`;

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(path: string): string;
}

const realIO: CliIO = {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
  readFile: (p) => readFileSync(p, "utf8"),
};

/** Run a program from source text and return the process exit code. */
export function runSource(source: string, filename: string, io: CliIO): number {
  const interp = new Interpreter({ out: io.stdout });
  try {
    interp.runSource(source);
    return 0;
  } catch (e) {
    if (e instanceof CurioSyntaxError) {
      io.stderr(e.format(source, filename) + "\n");
      return 65;
    }
    if (e instanceof CurioRuntimeError) {
      io.stderr(e.format(source, filename) + "\n");
      return 70;
    }
    throw e;
  }
}

/** Handle command line arguments. Returns the exit code, or "repl" if the REPL should start. */
export function main(args: string[], io: CliIO = realIO): number | "repl" {
  if (args.length === 0) return "repl";
  const [first, ...rest] = args as [string, ...string[]];

  if (first === "-h" || first === "--help") {
    io.stdout(USAGE + "\n");
    return 0;
  }
  if (first === "-v" || first === "--version") {
    io.stdout(`curio ${VERSION}\n`);
    return 0;
  }
  if (first === "-e") {
    if (rest.length !== 1) {
      io.stderr("curio: -e needs exactly one argument, the code to run\n");
      return 64;
    }
    return runSource(rest[0]!, "<-e>", io);
  }
  if (first.startsWith("-") || rest.length > 0) {
    io.stderr(`curio: unexpected arguments. Try 'curio --help'.\n`);
    return 64;
  }

  let source: string;
  try {
    source = io.readFile(first);
  } catch {
    io.stderr(`curio: cannot read '${first}'\n`);
    return 66;
  }
  return runSource(source, first, io);
}

/* v8 ignore start: terminal wiring, exercised by hand (the logic lives in ReplSession) */
function startRepl(): void {
  const tty = Boolean(process.stdin.isTTY);
  const session = new ReplSession((t) => void process.stdout.write(t));
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  const prompt = () => rl.setPrompt(tty ? (session.isContinuing ? "  ...> " : "curio> ") : "");
  if (tty) console.log(`Curio ${VERSION}. Type .help for help, .exit to quit.`);
  prompt();
  rl.prompt();
  rl.on("line", (line) => {
    if (session.feed(line) === "exit") {
      rl.close();
      return;
    }
    prompt();
    rl.prompt();
  });
  rl.on("SIGINT", () => {
    session.cancel();
    if (tty) process.stdout.write("\n");
    prompt();
    rl.prompt();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = main(process.argv.slice(2));
  if (result === "repl") startRepl();
  else process.exitCode = result;
}
/* v8 ignore stop */
