// Lexer: turns source text into tokens. It never throws; problems are collected as
// diagnostics so the parser (and the user) can see several errors in one run.

import type { Diagnostic } from "./errors.js";
import { KEYWORDS, T, type TemplatePart, type Token } from "./token.js";

export interface LexResult {
  tokens: Token[];
  errors: Diagnostic[];
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  "\\": "\\",
  '"': '"',
  "'": "'",
  $: "$",
};

const ONE_CHAR: Readonly<Record<string, T>> = {
  "+": T.Plus,
  "-": T.Minus,
  "*": T.Star,
  "/": T.Slash,
  "%": T.Percent,
  "(": T.LParen,
  ")": T.RParen,
  "{": T.LBrace,
  "}": T.RBrace,
  "[": T.LBracket,
  "]": T.RBracket,
  ",": T.Comma,
  ";": T.Semicolon,
  ":": T.Colon,
};

const isDigit = (c: string) => c >= "0" && c <= "9";
const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isAlnum = (c: string) => isAlpha(c) || isDigit(c);

export function lex(source: string): LexResult {
  return new Lexer(source).run();
}

class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;
  private readonly errors: Diagnostic[] = [];

  constructor(private readonly src: string) {}

  run(): LexResult {
    const tokens: Token[] = [];
    for (;;) {
      const tok = this.next();
      tokens.push(tok);
      if (tok.type === T.EOF) break;
    }
    return { tokens, errors: this.errors };
  }

  // --- character helpers -------------------------------------------------

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  private advance(): string {
    const c = this.src[this.pos++]!;
    if (c === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private error(message: string, line: number, col: number, length: number, atEof = false): void {
    this.errors.push({ message, line, col, length: Math.max(1, length), ...(atEof ? { atEof } : {}) });
  }

  private make(type: T, lexeme: string, line: number, col: number, extra: Partial<Token> = {}): Token {
    return { type, lexeme, line, col, ...extra };
  }

  // --- scanning ----------------------------------------------------------

  /** Scan until a real token (or EOF) is produced, reporting any bad input on the way. */
  private next(): Token {
    for (;;) {
      this.skipTrivia();
      if (this.atEnd()) return this.make(T.EOF, "", this.line, this.col);

      const line = this.line;
      const col = this.col;
      const start = this.pos;
      const c = this.peek();

      if (isDigit(c)) return this.number(line, col, start);
      if (isAlpha(c)) return this.identifier(line, col, start);
      if (c === '"' || c === "'") {
        const tok = this.string(c, line, col, start);
        if (tok) return tok;
        continue; // unterminated string: error already recorded
      }

      const two = c + this.peek(1);
      const twoType = { "!=": T.BangEq, "==": T.EqEq, "<=": T.Le, ">=": T.Ge }[two];
      if (twoType) {
        this.advance();
        this.advance();
        return this.make(twoType, two, line, col);
      }
      const oneType = ONE_CHAR[c] ?? { "!": T.Bang, "=": T.Eq, "<": T.Lt, ">": T.Gt }[c];
      if (oneType) {
        this.advance();
        return this.make(oneType, c, line, col);
      }

      // Unknown character (handle astral characters as one unit).
      const ch = String.fromCodePoint(this.src.codePointAt(this.pos)!);
      for (let i = 0; i < ch.length; i++) this.advance();
      this.error(`Unexpected character '${ch}'`, line, col, ch.length);
    }
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.advance();
      } else if (c === "/" && this.peek(1) === "/") {
        while (!this.atEnd() && this.peek() !== "\n") this.advance();
      } else if (c === "/" && this.peek(1) === "*") {
        const line = this.line;
        const col = this.col;
        this.advance();
        this.advance();
        while (!this.atEnd() && !(this.peek() === "*" && this.peek(1) === "/")) this.advance();
        if (this.atEnd()) {
          this.error("Unterminated block comment", line, col, 2, true);
        } else {
          this.advance();
          this.advance();
        }
      } else {
        return;
      }
    }
  }

  private number(line: number, col: number, start: number): Token {
    while (isDigit(this.peek())) this.advance();
    if (this.peek() === "." && isDigit(this.peek(1))) {
      this.advance();
      while (isDigit(this.peek())) this.advance();
    }
    const e = this.peek();
    if (
      (e === "e" || e === "E") &&
      (isDigit(this.peek(1)) || ((this.peek(1) === "+" || this.peek(1) === "-") && isDigit(this.peek(2))))
    ) {
      this.advance();
      this.advance();
      while (isDigit(this.peek())) this.advance();
    }
    if (isAlpha(this.peek())) {
      // Something like 12abc: swallow the whole word so we report one error, not two.
      while (isAlnum(this.peek())) this.advance();
      const bad = this.src.slice(start, this.pos);
      this.error(`Invalid number '${bad}'`, line, col, bad.length);
      return this.make(T.Number, bad, line, col, { value: 0 });
    }
    const lexeme = this.src.slice(start, this.pos);
    return this.make(T.Number, lexeme, line, col, { value: Number(lexeme) });
  }

  private identifier(line: number, col: number, start: number): Token {
    while (isAlnum(this.peek())) this.advance();
    const lexeme = this.src.slice(start, this.pos);
    const kw = KEYWORDS.get(lexeme);
    return this.make(kw ?? T.Ident, lexeme, line, col);
  }

  /** Returns null when the string is unterminated (an error has been recorded). */
  private string(quote: string, line: number, col: number, start: number): Token | null {
    this.advance(); // opening quote
    const parts: TemplatePart[] = [];
    let text = "";
    let hasInterpolation = false;

    for (;;) {
      if (this.atEnd() || this.peek() === "\n") {
        this.error("Unterminated string", line, col, this.pos - start, this.atEnd());
        return null;
      }
      const c = this.peek();
      if (c === quote) {
        this.advance();
        break;
      }
      if (c === "\\") {
        const escLine = this.line;
        const escCol = this.col;
        this.advance();
        if (this.atEnd() || this.peek() === "\n") continue; // reported as unterminated next loop
        const e = this.advance();
        const mapped = SIMPLE_ESCAPES[e];
        if (mapped === undefined) {
          this.error(`Unknown escape sequence '\\${e}'`, escLine, escCol, 2);
        } else {
          text += mapped;
        }
        continue;
      }
      if (c === "$" && this.peek(1) === "{") {
        const exprLine = this.line;
        const exprCol = this.col;
        this.advance();
        this.advance();
        const exprTokens = this.interpolation(exprLine, exprCol);
        if (exprTokens === null) return null;
        hasInterpolation = true;
        if (text) parts.push(text);
        text = "";
        parts.push(exprTokens);
        continue;
      }
      text += this.advance();
    }

    const lexeme = this.src.slice(start, this.pos);
    if (!hasInterpolation) return this.make(T.String, lexeme, line, col, { value: text });
    if (text) parts.push(text);
    return this.make(T.Template, lexeme, line, col, { parts });
  }

  /** Lex the tokens of one `${ ... }` up to its matching brace. Null if the input ends first. */
  private interpolation(line: number, col: number): Token[] | null {
    const tokens: Token[] = [];
    let depth = 0;
    for (;;) {
      const tok = this.next();
      if (tok.type === T.EOF) {
        this.error("Unterminated string interpolation, expected '}'", line, col, 2, true);
        return null;
      }
      if (tok.type === T.LBrace) depth++;
      if (tok.type === T.RBrace) {
        if (depth === 0) {
          tokens.push(this.make(T.EOF, "", tok.line, tok.col));
          return tokens;
        }
        depth--;
      }
      tokens.push(tok);
    }
  }
}
