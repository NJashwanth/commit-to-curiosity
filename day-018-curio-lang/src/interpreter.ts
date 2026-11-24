// Tree-walking interpreter. Expressions evaluate to values; statements run for effect and
// yield a "completion value" (the last expression statement), which is how a block or a
// function body implicitly returns its last expression.

import type { BinaryOp, Block, Expr, Pos, Program, Stmt } from "./ast.js";
import { Environment } from "./environment.js";
import { CurioRuntimeError, type TraceFrame } from "./errors.js";
import { parseOrThrow } from "./parser.js";
import { installStdlib } from "./stdlib.js";
import { NativeFunction, isTruthy, stringify, typeOf, valuesEqual, type Value } from "./values.js";

export interface InterpreterOptions {
  /** Where print() writes. Defaults to stdout. */
  out?: (text: string) => void;
  /** Abort after this many statements and calls (guards against endless loops in the playground). */
  maxSteps?: number;
}

/** Why the innermost statement list stopped early, if it did. */
const enum Ctl {
  None,
  Break,
  Continue,
  Return,
}

export class Interpreter {
  readonly globals = new Environment();
  private env: Environment = this.globals;
  private ctl: Ctl = Ctl.None;
  private steps = 0;
  private readonly out: (text: string) => void;
  private readonly maxSteps: number;

  constructor(options: InterpreterOptions = {}) {
    this.out = options.out ?? ((text) => void process.stdout.write(text));
    this.maxSteps = options.maxSteps ?? Infinity;
    installStdlib(this.globals);
  }

  /** Parse and run source text. Throws CurioSyntaxError or CurioRuntimeError. */
  runSource(source: string): Value {
    return this.run(parseOrThrow(source));
  }

  /** Run a program in the global scope and return the value of its last statement. */
  run(program: Program): Value {
    this.env = this.globals;
    this.ctl = Ctl.None;
    this.steps = 0;
    try {
      let last: Value = null;
      for (const stmt of program.body) last = this.exec(stmt);
      return last;
    } finally {
      this.env = this.globals;
      this.ctl = Ctl.None;
    }
  }

  // --- errors ------------------------------------------------------------

  private trace(line: number): TraceFrame[] {
    return [{ name: "<main>", line }];
  }

  private fail(message: string, pos: Pos): never {
    throw new CurioRuntimeError(message, pos.line, pos.col, this.trace(pos.line));
  }

  private tick(pos: Pos): void {
    if (++this.steps > this.maxSteps) {
      this.fail(`Execution limit of ${this.maxSteps} steps exceeded (is there an endless loop?)`, pos);
    }
  }

  // --- statements --------------------------------------------------------

  private exec(stmt: Stmt): Value {
    this.tick(stmt.pos);
    switch (stmt.kind) {
      case "ExprStmt":
        return this.eval(stmt.expr);
      case "Let":
        this.env.define(stmt.name, stmt.init ? this.eval(stmt.init) : null);
        return null;
      case "Block":
        return this.execBlock(stmt);
      case "If": {
        if (isTruthy(this.eval(stmt.cond))) return this.execBlock(stmt.then);
        if (stmt.otherwise) return this.exec(stmt.otherwise);
        return null;
      }
      case "While":
        while (isTruthy(this.eval(stmt.cond))) {
          this.tick(stmt.pos);
          this.execBlock(stmt.body);
          if (this.loopShouldExit()) break;
        }
        return null;
      case "For": {
        const items = this.iterate(this.eval(stmt.iterable), stmt.pos);
        for (const item of items) {
          // A fresh scope per iteration, so closures capture that iteration's variable.
          const outer = this.env;
          this.env = new Environment(outer);
          this.env.define(stmt.variable, item);
          try {
            this.execBlock(stmt.body);
          } finally {
            this.env = outer;
          }
          if (this.loopShouldExit()) break;
        }
        return null;
      }
      case "Return":
        this.ctl = Ctl.Return;
        return null;
      case "Break":
        this.ctl = Ctl.Break;
        return null;
      case "Continue":
        this.ctl = Ctl.Continue;
        return null;
    }
  }

  /** After a loop body: true to leave the loop. A `continue` is consumed here. */
  private loopShouldExit(): boolean {
    if (this.ctl === Ctl.Continue) this.ctl = Ctl.None;
    if (this.ctl === Ctl.Break) {
      this.ctl = Ctl.None;
      return true;
    }
    return this.ctl === Ctl.Return;
  }

  private execBlock(block: Block): Value {
    const outer = this.env;
    this.env = new Environment(outer);
    try {
      let last: Value = null;
      for (const stmt of block.body) {
        last = this.exec(stmt);
        if (this.ctl !== Ctl.None) break;
      }
      return last;
    } finally {
      this.env = outer;
    }
  }

  private iterate(v: Value, pos: Pos): Value[] {
    if (typeof v === "string") return [...v];
    return this.fail(`Cannot loop over a value of type ${typeOf(v)}`, pos);
  }

  // --- expressions -------------------------------------------------------

  private eval(e: Expr): Value {
    switch (e.kind) {
      case "Number":
      case "String":
      case "Bool":
        return e.value;
      case "Nil":
        return null;
      case "Ident": {
        const v = this.env.get(e.name);
        if (v === undefined) this.fail(`Undefined variable '${e.name}'`, e.pos);
        return v;
      }
      case "Unary": {
        const v = this.eval(e.operand);
        if (e.op === "!") return !isTruthy(v);
        if (typeof v !== "number") this.fail(`Operand of '-' must be a number, got ${typeOf(v)}`, e.pos);
        return -v;
      }
      case "Logical": {
        const left = this.eval(e.left);
        if (e.op === "or" ? isTruthy(left) : !isTruthy(left)) return left;
        return this.eval(e.right);
      }
      case "Binary":
        return this.binary(e.op, this.eval(e.left), this.eval(e.right), e.pos);
      case "Assign": {
        const value = this.eval(e.value);
        if (e.target.kind !== "Ident") return this.fail("Cannot assign to this expression", e.pos);
        if (!this.env.assign(e.target.name, value)) {
          this.fail(`Undefined variable '${e.target.name}' (declare it with let first)`, e.target.pos);
        }
        return value;
      }
      case "Call":
        return this.call(e);
      case "Index":
        return this.fail("Indexing is not supported yet", e.pos);
    }
  }

  private binary(op: BinaryOp, a: Value, b: Value, pos: Pos): Value {
    switch (op) {
      case "==":
        return valuesEqual(a, b);
      case "!=":
        return !valuesEqual(a, b);
      case "+":
        if (typeof a === "number" && typeof b === "number") return a + b;
        if (typeof a === "string" || typeof b === "string") return stringify(a) + stringify(b);
        return this.fail(`Cannot add ${typeOf(a)} and ${typeOf(b)}`, pos);
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const ok = (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
        if (!ok) this.fail(`Cannot compare ${typeOf(a)} and ${typeOf(b)} with '${op}'`, pos);
        const x = a as number | string;
        const y = b as number | string;
        return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
      }
      default: {
        // - * / % need two numbers
        if (typeof a !== "number" || typeof b !== "number") {
          this.fail(`Operands of '${op}' must be numbers, got ${typeOf(a)} and ${typeOf(b)}`, pos);
        }
        if (op === "-") return a - b;
        if (op === "*") return a * b;
        if (b === 0) this.fail(op === "/" ? "Division by zero" : "Modulo by zero", pos);
        return op === "/" ? a / b : a % b;
      }
    }
  }

  private call(e: Extract<Expr, { kind: "Call" }>): Value {
    const callee = this.eval(e.callee);
    const args = e.args.map((a) => this.eval(a));
    if (!(callee instanceof NativeFunction)) {
      return this.fail(`Cannot call a value of type ${typeOf(callee)}`, e.pos);
    }
    this.tick(e.pos);
    if (args.length < callee.minArgs || args.length > callee.maxArgs) {
      this.fail(`${callee.name}() takes ${arityText(callee.minArgs, callee.maxArgs)} but got ${args.length}`, e.pos);
    }
    try {
      return callee.fn(args, { out: this.out });
    } catch (err) {
      if (err instanceof CurioRuntimeError && err.line === 0) {
        err.line = e.pos.line;
        err.col = e.pos.col;
        err.trace = this.trace(e.pos.line);
      }
      throw err;
    }
  }
}

function arityText(min: number, max: number): string {
  const s = (n: number) => `${n} argument${n === 1 ? "" : "s"}`;
  if (min === max) return s(min);
  if (max === Infinity) return `at least ${s(min)}`;
  return `${min} to ${max} arguments`;
}
