// Tree-walking interpreter. Expressions evaluate to values; statements run for effect and
// yield a "completion value" (the last expression statement), which is how a block or a
// function body implicitly returns its last expression.

import type { BinaryOp, Block, Expr, Pos, Program, Stmt } from "./ast.js";
import { Environment } from "./environment.js";
import { CurioRuntimeError, type TraceFrame } from "./errors.js";
import { parseOrThrow } from "./parser.js";
import { installStdlib } from "./stdlib.js";
import { CurioFunction, NativeFunction, isTruthy, stringify, typeOf, valuesEqual, type Value } from "./values.js";

export const DEFAULT_MAX_CALL_DEPTH = 400;

export interface InterpreterOptions {
  /** Where print() writes. Defaults to stdout. */
  out?: (text: string) => void;
  /** Deepest allowed nesting of function calls before a "maximum call depth" error. */
  maxCallDepth?: number;
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
  private retVal: Value = null;
  /** Active Curio function calls, outermost first. `callLine` is where the call was made. */
  private readonly callStack: { name: string; callLine: number }[] = [];
  private readonly maxCallDepth: number;
  private readonly out: (text: string) => void;
  private readonly maxSteps: number;

  constructor(options: InterpreterOptions = {}) {
    this.out = options.out ?? ((text) => void process.stdout.write(text));
    this.maxSteps = options.maxSteps ?? Infinity;
    this.maxCallDepth = options.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH;
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
    this.callStack.length = 0;
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

  /** Stack trace for an error on `line`: innermost call first, then each caller, ending in <main>. */
  private trace(line: number): TraceFrame[] {
    const frames: TraceFrame[] = [];
    let current = line;
    for (let i = this.callStack.length - 1; i >= 0; i--) {
      frames.push({ name: this.callStack[i]!.name, line: current });
      current = this.callStack[i]!.callLine;
    }
    frames.push({ name: "<main>", line: current });
    return frames;
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
        this.retVal = stmt.value ? this.eval(stmt.value) : null;
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
      case "Function":
        return new CurioFunction(e.name, e.params, e.body, this.env);
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
    return this.callValue(callee, args, e.pos);
  }

  /** Call any callable value. `pos` is the call site, used for errors and the stack trace. */
  private callValue(callee: Value, args: Value[], pos: Pos): Value {
    this.tick(pos);
    if (callee instanceof NativeFunction) return this.callNative(callee, args, pos);
    if (!(callee instanceof CurioFunction)) {
      return this.fail(`Cannot call a value of type ${typeOf(callee)}`, pos);
    }
    const name = callee.name ?? "<anonymous>";
    if (args.length !== callee.params.length) {
      this.fail(`${name}() takes ${arityText(callee.params.length, callee.params.length)} but got ${args.length}`, pos);
    }
    if (this.callStack.length >= this.maxCallDepth) {
      this.fail(
        `Maximum call depth of ${this.maxCallDepth} exceeded. Is there a recursive function without a base case?`,
        pos,
      );
    }

    const scope = new Environment(callee.closure);
    callee.params.forEach((p, i) => scope.define(p, args[i]!));
    const outer = this.env;
    this.env = scope;
    this.callStack.push({ name, callLine: pos.line });
    try {
      // Run the body in the parameter scope. The function's value is its `return`, or else the
      // value of its last statement.
      let last: Value = null;
      for (const stmt of callee.body.body) {
        last = this.exec(stmt);
        if (this.ctl !== Ctl.None) break;
      }
      if (this.ctl === Ctl.Return) {
        this.ctl = Ctl.None;
        return this.retVal;
      }
      return last;
    } catch (err) {
      throw this.asRuntimeError(err, pos);
    } finally {
      this.callStack.pop();
      this.env = outer;
    }
  }

  private callNative(fn: NativeFunction, args: Value[], pos: Pos): Value {
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      this.fail(`${fn.name}() takes ${arityText(fn.minArgs, fn.maxArgs)} but got ${args.length}`, pos);
    }
    try {
      return fn.fn(args, { out: this.out });
    } catch (err) {
      throw this.asRuntimeError(err, pos);
    }
  }

  /**
   * Natives throw location-less errors; give them this call's position and trace. A JavaScript
   * stack overflow (a very deep expression, say) becomes an ordinary Curio error too.
   */
  private asRuntimeError(err: unknown, pos: Pos): unknown {
    if (err instanceof CurioRuntimeError && err.line === 0) {
      err.line = pos.line;
      err.col = pos.col;
      err.trace = this.trace(pos.line);
    } else if (err instanceof RangeError && err.message.includes("call stack")) {
      return new CurioRuntimeError("Stack overflow: the program nested too deeply", pos.line, pos.col, this.trace(pos.line));
    }
    return err;
  }
}

function arityText(min: number, max: number): string {
  const s = (n: number) => `${n} argument${n === 1 ? "" : "s"}`;
  if (min === max) return s(min);
  if (max === Infinity) return `at least ${s(min)}`;
  return `${min} to ${max} arguments`;
}
