// Parser: a Pratt (precedence climbing) parser for expressions.
//
// Precedence, lowest to highest:
//   assignment (right)  <  or  <  and  <  equality  <  comparison  <  term  <  factor
//   <  unary (prefix)  <  call / index (postfix)

import type { BinaryOp, Block, Expr, IfStmt, Pos, Program, Stmt } from "./ast.js";
import { CurioSyntaxError, type Diagnostic } from "./errors.js";
import { lex } from "./lexer.js";
import { T, describeToken, type Token } from "./token.js";

const enum Prec {
  Lowest = 0,
  Assign = 1,
  Or = 2,
  And = 3,
  Equality = 4,
  Comparison = 5,
  Term = 6,
  Factor = 7,
  Unary = 8,
  Call = 9,
}

/** Binding power of a token when it appears after a complete expression (0 if it cannot). */
function infixPrec(type: T): Prec {
  switch (type) {
    case T.Eq:
      return Prec.Assign;
    case T.Or:
      return Prec.Or;
    case T.And:
      return Prec.And;
    case T.EqEq:
    case T.BangEq:
      return Prec.Equality;
    case T.Lt:
    case T.Le:
    case T.Gt:
    case T.Ge:
      return Prec.Comparison;
    case T.Plus:
    case T.Minus:
      return Prec.Term;
    case T.Star:
    case T.Slash:
    case T.Percent:
      return Prec.Factor;
    case T.LParen:
    case T.LBracket:
      return Prec.Call;
    default:
      return Prec.Lowest;
  }
}

/** Thrown to unwind out of a bad construct; the diagnostic is also recorded. */
class ParseError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

const posOf = (t: Token): Pos => ({ line: t.line, col: t.col });

export class Parser {
  protected current = 0;
  /** How many loops enclose the statement being parsed (for break/continue checks). */
  protected loopDepth = 0;
  /** How many function bodies enclose the statement being parsed (for return checks). */
  protected fnDepth = 0;
  /** Map literals currently being parsed: their closing `}` is still ahead when an error hits. */
  private openMaps = 0;
  /** `openMaps` as it was when the latest error was raised (recovery needs it after unwinding). */
  private failedInMaps = 0;

  constructor(
    protected readonly tokens: Token[],
    readonly errors: Diagnostic[] = [],
  ) {}

  // --- token helpers -----------------------------------------------------

  protected peek(): Token {
    return this.tokens[this.current]!;
  }

  protected previous(): Token {
    return this.tokens[this.current - 1]!;
  }

  protected atEnd(): boolean {
    return this.peek().type === T.EOF;
  }

  protected advance(): Token {
    if (!this.atEnd()) this.current++;
    return this.previous();
  }

  protected check(type: T): boolean {
    return this.peek().type === type;
  }

  protected match(...types: T[]): boolean {
    if (types.includes(this.peek().type)) {
      this.advance();
      return true;
    }
    return false;
  }

  protected diagnosticAt(tok: Token, message: string): Diagnostic {
    const d: Diagnostic = { message, line: tok.line, col: tok.col, length: Math.max(1, tok.lexeme.length) };
    if (tok.type === T.EOF) d.atEof = true;
    return d;
  }

  /** Record an error and return an exception the caller can throw to unwind. */
  protected fail(tok: Token, message: string): ParseError {
    const d = this.diagnosticAt(tok, message);
    this.failedInMaps = this.openMaps;
    // An Error token was already reported by the lexer; just unwind so we do not pile on.
    if (tok.type !== T.Error) this.errors.push(d);
    return new ParseError(d);
  }

  /** Record an error without unwinding (the parser can keep going). */
  protected report(tok: Token, message: string): void {
    if (tok.type === T.Error) return;
    this.errors.push(this.diagnosticAt(tok, message));
  }

  protected consume(type: T, message: string): Token {
    if (this.check(type)) return this.advance();
    throw this.fail(this.peek(), `${message}, found ${describeToken(this.peek())}`);
  }

  // --- statements --------------------------------------------------------

  parseProgram(): Program {
    const body: Stmt[] = [];
    while (!this.atEnd()) {
      if (this.check(T.RBrace)) {
        // A stray closing brace: report it and move on so later errors still surface.
        this.report(this.advance(), "Unexpected '}' with no matching '{'");
        continue;
      }
      const stmt = this.declaration();
      if (stmt) body.push(stmt);
    }
    return { kind: "Program", body, pos: { line: 1, col: 1 } };
  }

  /** One statement with error recovery: on a syntax error, skip ahead to a safe point. */
  private declaration(): Stmt | null {
    const start = this.current;
    try {
      return this.statement();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.synchronize(start, this.failedInMaps);
      return null;
    }
  }

  /**
   * Panic-mode recovery. Skip tokens until just after a `;`, or just before something that
   * starts a statement (or closes a block), so one mistake yields one error, not a cascade.
   */
  private synchronize(start: number, openMaps: number): void {
    if (this.current === start && !this.atEnd()) this.advance(); // always make progress
    let skipped = 0; // `{` seen while skipping, so a skipped block is skipped whole
    while (!this.atEnd()) {
      if (skipped === 0 && this.previous().type === T.Semicolon) return;
      switch (this.peek().type) {
        case T.LBrace:
          skipped++;
          this.advance();
          break;
        case T.RBrace:
          if (skipped > 0) {
            this.advance();
            if (--skipped === 0) {
              this.match(T.Semicolon); // `let f = fn { };` : the `;` belongs to the skipped statement
              return;
            }
          } else if (openMaps > 0) {
            this.advance(); // the closing brace of the map literal we were inside
            openMaps--;
          } else {
            return; // the end of the enclosing block (or a stray brace, reported by the caller)
          }
          break;
        case T.Let:
        case T.Fn:
        case T.If:
        case T.While:
        case T.For:
        case T.Return:
        case T.Break:
        case T.Continue:
          if (skipped === 0) return;
          this.advance();
          break;
        default:
          this.advance();
      }
    }
  }

  private statement(): Stmt {
    const tok = this.peek();
    const pos = posOf(tok);
    switch (tok.type) {
      case T.Let:
        return this.letStatement();
      case T.If:
        return this.ifStatement();
      case T.While: {
        this.advance();
        const cond = this.parseExpression();
        const body = this.loopBody("Expected '{' after while condition");
        return { kind: "While", cond, body, pos };
      }
      case T.For: {
        this.advance();
        const name = this.consume(T.Ident, "Expected loop variable name after 'for'");
        this.consume(T.In, "Expected 'in' after loop variable");
        const iterable = this.parseExpression();
        const body = this.loopBody("Expected '{' after for iterable");
        return { kind: "For", variable: name.lexeme, iterable, body, pos };
      }
      case T.Return: {
        this.advance();
        if (this.fnDepth === 0) this.report(tok, "'return' outside of a function");
        let value: Expr | null = null;
        if (!this.check(T.Semicolon) && !this.check(T.RBrace) && !this.atEnd()) value = this.parseExpression();
        this.endStatement("Expected ';' after return value");
        return { kind: "Return", value, pos };
      }
      case T.Break:
      case T.Continue: {
        this.advance();
        const word = tok.type === T.Break ? "break" : "continue";
        if (this.loopDepth === 0) this.report(tok, `'${word}' outside of a loop`);
        this.endStatement(`Expected ';' after '${word}'`);
        return tok.type === T.Break ? { kind: "Break", pos } : { kind: "Continue", pos };
      }
      case T.LBrace:
        // `{ key: ...` can only be a map literal (a block never starts with `name:`).
        if (this.startsMapLiteral()) return this.expressionStatement(pos);
        return this.block();
      case T.Fn:
        // `fn name(...) { }` declares a function; `fn(...) { }` is an expression.
        if (this.tokens[this.current + 1]?.type === T.Ident) return this.fnDeclaration();
        return this.expressionStatement(pos);
      default:
        return this.expressionStatement(pos);
    }
  }

  private startsMapLiteral(): boolean {
    const key = this.tokens[this.current + 1]?.type;
    const colon = this.tokens[this.current + 2]?.type;
    const keyLike = key === T.Ident || key === T.String || key === T.Number || key === T.True || key === T.False;
    return keyLike && colon === T.Colon;
  }

  private expressionStatement(pos: Pos): Stmt {
    const expr = this.parseExpression();
    this.endStatement("Expected ';' after expression");
    return { kind: "ExprStmt", expr, pos };
  }

  /** `fn name(a, b) { ... }` is sugar for `let name = fn(a, b) { ... };` */
  private fnDeclaration(): Stmt {
    const tok = this.advance();
    const name = this.advance();
    const fn = this.functionRest(tok, name.lexeme);
    return { kind: "Let", name: name.lexeme, init: fn, pos: posOf(tok) };
  }

  /** Everything after `fn` (and the optional name): `(params) { body }`. */
  private functionRest(fnTok: Token, name: string | null): Expr {
    this.consume(T.LParen, "Expected '(' after 'fn'");
    const params: string[] = [];
    if (!this.check(T.RParen)) {
      do {
        if (this.check(T.RParen)) break; // trailing comma
        const p = this.consume(T.Ident, "Expected parameter name");
        if (params.includes(p.lexeme)) this.report(p, `Duplicate parameter '${p.lexeme}'`);
        params.push(p.lexeme);
      } while (this.match(T.Comma));
    }
    this.consume(T.RParen, "Expected ')' after parameters");
    // A function body starts a fresh context: outer loops do not apply, `return` does.
    const savedLoops = this.loopDepth;
    this.loopDepth = 0;
    this.fnDepth++;
    try {
      const body = this.block("Expected '{' before function body");
      return { kind: "Function", name, params, body, pos: posOf(fnTok) };
    } finally {
      this.fnDepth--;
      this.loopDepth = savedLoops;
    }
  }

  private letStatement(): Stmt {
    const tok = this.advance();
    const name = this.consume(T.Ident, "Expected variable name after 'let'");
    let init: Expr | null = null;
    if (this.match(T.Eq)) init = this.parseExpression();
    if (init?.kind === "Function" && init.name === null) init.name = name.lexeme; // for stack traces
    this.endStatement("Expected ';' after variable declaration");
    return { kind: "Let", name: name.lexeme, init, pos: posOf(tok) };
  }

  private ifStatement(): IfStmt {
    const tok = this.advance();
    const cond = this.parseExpression();
    const then = this.block("Expected '{' after if condition");
    let otherwise: Block | IfStmt | null = null;
    if (this.match(T.Else)) {
      otherwise = this.check(T.If) ? this.ifStatement() : this.block("Expected '{' or 'if' after 'else'");
    }
    return { kind: "If", cond, then, otherwise, pos: posOf(tok) };
  }

  private loopBody(message: string): Block {
    this.loopDepth++;
    try {
      return this.block(message);
    } finally {
      this.loopDepth--;
    }
  }

  /** `{ statements }`. Statements that fail are skipped, so the rest of the block still parses. */
  protected block(message = "Expected '{'"): Block {
    const open = this.consume(T.LBrace, message);
    const body: Stmt[] = [];
    while (!this.check(T.RBrace) && !this.atEnd()) {
      const stmt = this.declaration();
      if (stmt) body.push(stmt);
    }
    this.consume(T.RBrace, "Expected '}' to close the block");
    return { kind: "Block", body, pos: posOf(open) };
  }

  /** A `;` ends a statement, but it may be left out before a closing `}` or at the end of input. */
  private endStatement(message: string): void {
    if (this.match(T.Semicolon) || this.check(T.RBrace) || this.atEnd()) return;
    throw this.fail(this.peek(), `${message}, found ${describeToken(this.peek())}`);
  }

  /** Parse exactly one expression followed by end of input (used by tests and tools). */
  parseSingleExpression(): Expr | null {
    try {
      const expr = this.parseExpression();
      if (!this.atEnd()) throw this.fail(this.peek(), `Unexpected ${describeToken(this.peek())} after expression`);
      return expr;
    } catch (e) {
      if (e instanceof ParseError) return null;
      throw e;
    }
  }

  // --- expressions -------------------------------------------------------

  /** Parse one expression. Throws ParseError after recording the diagnostic. */
  protected parseExpression(minPrec: Prec = Prec.Assign): Expr {
    let left = this.parsePrefix();
    for (;;) {
      const tok = this.peek();
      const prec = infixPrec(tok.type);
      if (prec === Prec.Lowest || prec < minPrec) return left;
      this.advance();

      switch (tok.type) {
        case T.Eq: {
          // Right associative: a = b = c is a = (b = c).
          const value = this.parseExpression(Prec.Assign);
          if (left.kind === "Ident" || left.kind === "Index") {
            if (left.kind === "Ident" && value.kind === "Function" && value.name === null) value.name = left.name;
            left = { kind: "Assign", target: left, value, pos: posOf(tok) };
          } else {
            this.report(tok, "Invalid assignment target");
          }
          break;
        }
        case T.Or:
        case T.And: {
          const right = this.parseExpression(prec + 1);
          left = { kind: "Logical", op: tok.type === T.Or ? "or" : "and", left, right, pos: posOf(tok) };
          break;
        }
        case T.LParen:
          left = this.finishCall(left, tok);
          break;
        case T.LBracket: {
          const index = this.parseExpression(Prec.Assign);
          this.consume(T.RBracket, "Expected ']' after index");
          left = { kind: "Index", object: left, index, pos: posOf(tok) };
          break;
        }
        default: {
          // Left associative binary operator: the right side may only hold tighter operators.
          const right = this.parseExpression(prec + 1);
          left = { kind: "Binary", op: tok.type as BinaryOp, left, right, pos: posOf(tok) };
        }
      }
    }
  }

  private finishCall(callee: Expr, open: Token): Expr {
    const args: Expr[] = [];
    if (!this.check(T.RParen)) {
      do {
        if (this.check(T.RParen)) break; // trailing comma
        args.push(this.parseExpression());
      } while (this.match(T.Comma));
    }
    this.consume(T.RParen, "Expected ')' after arguments");
    return { kind: "Call", callee, args, pos: posOf(open) };
  }

  private arrayLiteral(pos: Pos): Expr {
    const elements: Expr[] = [];
    while (!this.check(T.RBracket) && !this.atEnd()) {
      elements.push(this.parseExpression());
      if (!this.match(T.Comma)) break;
    }
    this.consume(T.RBracket, "Expected ']' after array elements");
    return { kind: "Array", elements, pos };
  }

  /** `{ key: value, ... }`. A bare identifier key means the string of the same name. */
  private mapLiteral(pos: Pos): Expr {
    const entries: { key: Expr; value: Expr }[] = [];
    this.openMaps++;
    while (!this.check(T.RBrace) && !this.atEnd()) {
      let key: Expr;
      const first = this.peek();
      if (first.type === T.Ident && this.tokens[this.current + 1]?.type === T.Colon) {
        this.advance();
        key = { kind: "String", value: first.lexeme, pos: posOf(first) };
      } else {
        key = this.parseExpression();
      }
      this.consume(T.Colon, "Expected ':' after map key");
      entries.push({ key, value: this.parseExpression() });
      if (!this.match(T.Comma)) break;
    }
    this.consume(T.RBrace, "Expected '}' after map entries");
    this.openMaps--;
    return { kind: "Map", entries, pos };
  }

  /** A string with ${...} parts: parse each embedded token list as its own expression. */
  private template(tok: Token): Expr {
    const parts: (string | Expr)[] = [];
    for (const part of tok.parts!) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      const sub = new Parser(part, this.errors);
      try {
        if (sub.check(T.EOF)) throw sub.fail(sub.peek(), "Expected an expression inside '${}'");
        parts.push(sub.parseExpression());
        if (!sub.atEnd()) throw sub.fail(sub.peek(), `Unexpected ${describeToken(sub.peek())} in string interpolation`);
      } catch (e) {
        this.failedInMaps = this.openMaps;
        throw e;
      }
    }
    return { kind: "Template", parts, pos: posOf(tok) };
  }

  private parsePrefix(): Expr {
    const tok = this.peek();
    if (tok.type === T.EOF) throw this.fail(tok, "Expected expression, found end of input");
    this.advance();
    const pos = posOf(tok);
    switch (tok.type) {
      case T.Number:
        return { kind: "Number", value: tok.value as number, pos };
      case T.String:
        return { kind: "String", value: tok.value as string, pos };
      case T.True:
        return { kind: "Bool", value: true, pos };
      case T.False:
        return { kind: "Bool", value: false, pos };
      case T.Nil:
        return { kind: "Nil", pos };
      case T.Ident:
        return { kind: "Ident", name: tok.lexeme, pos };
      case T.Minus:
      case T.Bang:
        return { kind: "Unary", op: tok.type, operand: this.parseExpression(Prec.Unary), pos };
      case T.Fn:
        return this.functionRest(tok, null);
      case T.LBracket:
        return this.arrayLiteral(pos);
      case T.LBrace:
        return this.mapLiteral(pos);
      case T.Template:
        return this.template(tok);
      case T.LParen: {
        const inner = this.parseExpression();
        this.consume(T.RParen, "Expected ')' after expression");
        return inner;
      }
      default:
        // Step back so the bad token is the one reported (and not skipped).
        this.current--;
        throw this.fail(tok, `Expected expression, found ${describeToken(tok)}`);
    }
  }
}

export interface ExprResult {
  expr: Expr | null;
  errors: Diagnostic[];
}

/** Parse a single expression from source text (the whole input must be that expression). */
export function parseExpr(source: string): ExprResult {
  const lexed = lex(source);
  const errors = [...lexed.errors];
  const parser = new Parser(lexed.tokens, errors);
  return { expr: parser.parseSingleExpression(), errors: sortDiagnostics(errors) };
}

export function sortDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  return [...ds].sort((a, b) => a.line - b.line || a.col - b.col);
}

export interface ParseResult {
  program: Program;
  /** Lexer and parser errors together, in source order. Empty when the source is valid. */
  errors: Diagnostic[];
}

/** Parse a whole program (numbering lines from `startLine`). Never throws: syntax errors come back in `errors`. */
export function parse(source: string, startLine = 1): ParseResult {
  const lexed = lex(source, startLine);
  const errors = [...lexed.errors];
  const program = new Parser(lexed.tokens, errors).parseProgram();
  return { program, errors: dedupe(sortDiagnostics(errors)) };
}

/** Parse a whole program, throwing a CurioSyntaxError listing every problem found. */
export function parseOrThrow(source: string): Program {
  const { program, errors } = parse(source);
  if (errors.length > 0) throw new CurioSyntaxError(errors);
  return program;
}

function dedupe(ds: Diagnostic[]): Diagnostic[] {
  return ds.filter((d, i) => i === 0 || d.line !== ds[i - 1]!.line || d.col !== ds[i - 1]!.col);
}
