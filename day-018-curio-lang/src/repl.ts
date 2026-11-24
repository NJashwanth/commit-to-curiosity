// REPL session logic, kept free of any terminal code so it can be tested directly.
//
// Feed it one line at a time. If the input so far is an unfinished statement (an unclosed
// `{`, a trailing operator...), it says "more" and waits for the next line. State (variables,
// functions) lives in one Interpreter for the whole session.

import { formatDiagnostics, CurioRuntimeError, CurioSyntaxError } from "./errors.js";
import { Interpreter } from "./interpreter.js";
import { parse } from "./parser.js";
import { stringify } from "./values.js";

export type ReplStatus = "more" | "done" | "exit";

export const REPL_HELP = [
  "Type Curio code and press Enter. Unfinished input (an open { or ( ) continues on the next line.",
  "Expression results are echoed. Commands:",
  "  .help    show this help",
  "  .reset   forget all variables and functions",
  "  .exit    leave the REPL (or press Ctrl+D)",
].join("\n");

export class ReplSession {
  private interp: Interpreter;
  /** Every line of input so far, so errors in functions defined earlier can still show their source. */
  private readonly history: string[] = [];
  private pending: string[] = [];

  constructor(private readonly write: (text: string) => void) {
    this.interp = new Interpreter({ out: write });
  }

  /** True while a multi-line statement is half typed. */
  get isContinuing(): boolean {
    return this.pending.length > 0;
  }

  feed(line: string): ReplStatus {
    if (this.pending.length === 0 && line.trim().startsWith(".")) return this.command(line.trim());
    this.pending.push(line);
    const source = this.pending.join("\n");
    if (source.trim() === "") {
      this.pending = [];
      return "done";
    }

    const startLine = this.history.length + 1;
    const { program, errors } = parse(source, startLine);
    if (errors.length > 0 && errors.every((e) => e.atEof)) return "more";

    // The input is complete (or hopelessly wrong): either way it is consumed now.
    const lines = this.pending;
    this.pending = [];
    this.history.push(...lines);
    const fullSource = this.history.join("\n");

    if (errors.length > 0) {
      this.write(formatDiagnostics(fullSource, errors, "<repl>") + "\n");
      return "done";
    }
    try {
      const value = this.interp.run(program);
      const last = program.body[program.body.length - 1];
      if (last?.kind === "ExprStmt" && value !== null) this.write(stringify(value, true) + "\n");
    } catch (e) {
      if (e instanceof CurioRuntimeError) this.write(e.format(fullSource, "<repl>") + "\n");
      else if (e instanceof CurioSyntaxError) this.write(e.format(fullSource, "<repl>") + "\n");
      else throw e;
    }
    return "done";
  }

  /** Abandon a half-typed statement (Ctrl+C). */
  cancel(): void {
    this.pending = [];
  }

  private command(cmd: string): ReplStatus {
    switch (cmd) {
      case ".exit":
      case ".quit":
        return "exit";
      case ".help":
        this.write(REPL_HELP + "\n");
        return "done";
      case ".reset":
        this.interp = new Interpreter({ out: this.write });
        this.history.length = 0;
        this.write("State cleared.\n");
        return "done";
      default:
        this.write(`Unknown command '${cmd}'. Type .help for the list.\n`);
        return "done";
    }
  }
}
