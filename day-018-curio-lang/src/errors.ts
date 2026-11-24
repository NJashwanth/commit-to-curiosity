// Diagnostics: syntax errors found by the lexer and parser, with source-aware formatting.

export interface Diagnostic {
  message: string;
  line: number;
  col: number;
  /** Number of characters to underline (at least 1). */
  length: number;
  /** True when the error is only "the input ended too early" (used by the REPL to ask for more). */
  atEof?: boolean;
}

/** Thrown when source code has one or more syntax errors. */
export class CurioSyntaxError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.line}:${d.col}: ${d.message}`).join("\n"));
    this.name = "CurioSyntaxError";
    this.diagnostics = diagnostics;
  }

  format(source: string, filename?: string): string {
    return formatDiagnostics(source, this.diagnostics, filename);
  }
}

/**
 * Render a message with the offending source line and a caret under the bad token:
 *
 *     error: Expected expression but found ';'
 *       --> demo.curio:2:9
 *        |
 *      2 | let y = ;
 *        |         ^
 */
export function formatDiagnostic(
  source: string,
  d: { message: string; line: number; col: number; length?: number },
  filename?: string,
  label = "error",
): string {
  const lines = source.split(/\r\n|\r|\n/);
  const text = lines[d.line - 1] ?? "";
  const gutter = String(d.line).length;
  const pad = " ".repeat(gutter);
  const room = Math.max(1, text.length - (d.col - 1));
  const width = Math.max(1, Math.min(d.length ?? 1, room));
  const caret = "^" + "~".repeat(width - 1);
  const where = `${filename ?? "<input>"}:${d.line}:${d.col}`;
  return [
    `${label}: ${d.message}`,
    `${pad} --> ${where}`,
    `${pad} |`,
    `${d.line} | ${text}`,
    `${pad} | ${text.slice(0, Math.max(0, d.col - 1)).replace(/[^\t]/g, " ")}${caret}`,
  ].join("\n");
}

export function formatDiagnostics(source: string, ds: Diagnostic[], filename?: string): string {
  const body = ds.map((d) => formatDiagnostic(source, d, filename)).join("\n\n");
  const n = ds.length;
  return `${body}\n\n${n} syntax error${n === 1 ? "" : "s"} found.`;
}
