import { describe, expect, it } from "vitest";
import { dumpAst, toSexpr } from "../src/ast.js";
import { DEFAULT_MAX_CALL_DEPTH, Interpreter } from "../src/interpreter.js";
import { parse, parseExpr } from "../src/parser.js";
import { CurioFunction, stringify, typeOf } from "../src/values.js";
import { out, run, runtimeError, val } from "./helpers.js";
import { CurioRuntimeError } from "../src/errors.js";
import { NativeFunction } from "../src/values.js";
import type { Environment } from "../src/environment.js";

const oneArg = (g: Environment) => g.define("one", new NativeFunction("one", 1, 1, () => null));
const failing = (g: Environment) =>
  g.define("fail", new NativeFunction("fail", 0, 0, () => { throw new CurioRuntimeError("native failure"); }));

const lines = (...l: string[]) => l.join("\n");
const messages = (src: string) => parse(src).errors.map((e) => `${e.line}:${e.col} ${e.message}`);

describe("parser: functions", () => {
  it("parses a function expression, naming it from its let", () => {
    const { program, errors } = parse("let add = fn(a, b) { return a + b; };");
    expect(errors).toEqual([]);
    expect(dumpAst(program)).toBe(
      lines(
        "Program",
        "  Let add",
        "    Function add(a, b)",
        "      body: Block",
        "        Return",
        "          Binary +",
        "            Ident a",
        "            Ident b",
      ),
    );
  });

  it("parses fn declarations as sugar for let + function", () => {
    const { program, errors } = parse("fn greet(name) { name; }");
    expect(errors).toEqual([]);
    expect(dumpAst(program)).toBe(
      lines("Program", "  Let greet", "    Function greet(name)", "      body: Block", "        ExprStmt", "          Ident name"),
    );
  });

  it("keeps anonymous functions anonymous, and names functions assigned to a variable", () => {
    expect(dumpAst(parse("fn() { }();").program)).toContain("Function <anonymous>()");
    expect(dumpAst(parse("let f; f = fn() { };").program)).toContain("Function f()");
    expect(toSexpr(parseExpr("fn(a, b) { }").expr!)).toBe("(fn _ (a b))");
  });

  it("parses return with and without a value", () => {
    const { program, errors } = parse("fn f() { return; return 1; }");
    expect(errors).toEqual([]);
    expect(dumpAst(program)).toBe(
      lines("Program", "  Let f", "    Function f()", "      body: Block", "        Return", "        Return", "          Number 1"),
    );
  });

  it("allows trailing commas in parameter lists", () => {
    expect(parse("fn f(a, b,) { }").errors).toEqual([]);
  });

  it("allows return, but not break/continue, inside a function nested in a loop", () => {
    expect(messages("fn f() { return 1; }")).toEqual([]);
    expect(messages("while true { fn f() { break; } }")).toEqual(["1:23 'break' outside of a loop"]);
    expect(messages("while true { let g = fn() { while true { break; } }; break; }")).toEqual([]);
  });

  it("still rejects return at the top level and in a loop outside a function", () => {
    expect(messages("while true { return 1; }")).toEqual(["1:14 'return' outside of a function"]);
  });

  it("explains malformed functions", () => {
    expect(messages("let f = fn { };")).toEqual(["1:12 Expected '(' after 'fn', found '{'"]);
    expect(messages("let f = fn(1) { };")).toEqual(["1:12 Expected parameter name, found number 1"]);
    expect(messages("let f = fn(a b) { };")).toEqual(["1:14 Expected ')' after parameters, found identifier 'b'"]);
    expect(messages("let f = fn(a) 1;")).toEqual(["1:15 Expected '{' before function body, found number 1"]);
    expect(messages("fn f(a, a) { }")).toEqual(["1:9 Duplicate parameter 'a'"]);
  });
});

describe("interpreter: functions", () => {
  it("calls functions with arguments and returns values", () => {
    expect(val("let add = fn(a, b) { return a + b; }; add(2, 3)")).toBe(5);
    expect(val("fn double(x) { return x * 2; } double(21)")).toBe(42);
    expect(val("fn() { return 7; }()")).toBe(7);
    expect(val("let f = fn() { }; f()")).toBe(null);
    expect(val("let f = fn() { return; }; f()")).toBe(null);
  });

  it("returns the value of the last expression when there is no return", () => {
    expect(val("let sq = fn(x) { x * x; }; sq(6)")).toBe(36);
    expect(val("let sq = fn(x) { x * x }; sq(7)")).toBe(49);
    expect(val("let f = fn(x) { if x > 0 { 1; } else { 2; } }; f(5) + f(-5)")).toBe(3);
    expect(val("let f = fn() { let a = 1; }; f()")).toBe(null);
    expect(val("let f = fn(n) { while n > 0 { n = n - 1; } }; f(3)")).toBe(null);
  });

  it("returns early from nested blocks and loops", () => {
    expect(val("fn f(n) { if n > 1 { return 100; } return 1; } f(5)")).toBe(100);
    expect(val("fn find() { let i = 0; while true { i = i + 1; if i == 4 { return i; } } } find()")).toBe(4);
    expect(val('fn first() { for c in "xyz" { return c; } } first()')).toBe("x");
    expect(out("fn f() { return 1; print(\"unreachable\"); } f();")).toBe("");
  });

  it("does not let return leak out of the function that executed it", () => {
    expect(out("fn a() { return 1; } fn b() { a(); print(\"after\"); } b();")).toBe("after\n");
  });

  it("passes functions as values", () => {
    expect(val("fn apply(f, x) { return f(x); } apply(fn(n) { n + 1; }, 41)")).toBe(42);
    expect(val("fn compose(f, g) { return fn(x) { return f(g(x)); }; } let h = compose(fn(x) { x + 1; }, fn(x) { x * 2; }); h(5)")).toBe(11);
    expect(val("let fs = fn() { return fn() { return fn() { return 3; }; }; }; fs()()()")).toBe(3);
  });

  it("checks argument counts", () => {
    const e = runtimeError("fn f(a, b) { }\nf(1);");
    expect(e.message).toBe("f() takes 2 arguments but got 1");
    expect([e.line, e.col]).toEqual([2, 2]);
    expect(runtimeError("fn f() { } f(1)").message).toBe("f() takes 0 arguments but got 1");
    expect(runtimeError("fn f(a) { } f()").message).toBe("f() takes 1 argument but got 0");
    expect(runtimeError("fn() { }(1)").message).toBe("<anonymous>() takes 0 arguments but got 1");
    expect(runtimeError("one()", { setup: oneArg }).message).toBe("one() takes 1 argument but got 0");
  });

  it("describes functions as values", () => {
    const f = val("fn named() { } named");
    expect(f).toBeInstanceOf(CurioFunction);
    expect(stringify(f)).toBe("<fn named>");
    expect(stringify(val("fn() { }"))).toBe("<fn anonymous>");
    expect(typeOf(f)).toBe("function");
    expect(val("fn a() { } a == a")).toBe(true);
    expect(val("fn a() { } fn b() { } a == b")).toBe(false);
  });
});

describe("interpreter: closures", () => {
  it("captures variables so a counter keeps its own state", () => {
    const src = `
      let makeCounter = fn() {
        let count = 0;
        return fn() { count = count + 1; return count; };
      };
      let next = makeCounter();
      let other = makeCounter();
      print(next(), next(), next());
      print(other());`;
    expect(out(src)).toBe("1 2 3\n1\n");
  });

  it("builds adders that remember their argument", () => {
    const src = `
      let adder = fn(n) { return fn(x) { return x + n; }; };
      let add5 = adder(5);
      let add10 = adder(10);
      print(add5(1), add10(1), add5(add10(0)));`;
    expect(out(src)).toBe("6 11 15\n");
  });

  it("shares one captured variable between closures created together", () => {
    const shared = `
      let inc; let get;
      {
        let n = 0;
        inc = fn() { n = n + 1; };
        get = fn() { n; };
      }
      inc(); inc();
      get()`;
    expect(val(shared)).toBe(2);
  });

  it("reads variables as they are when called, not when defined", () => {
    expect(val("let x = 1; let f = fn() { x; }; x = 2; f()")).toBe(2);
  });

  it("uses lexical, not dynamic, scope", () => {
    const src = `
      let x = "global";
      fn show() { x; }
      fn run() { let x = "local"; return show(); }
      run()`;
    expect(val(src)).toBe("global");
  });

  it("gives each for-in iteration its own variable", () => {
    const src = `
      let fns = nil;
      let first; let second;
      for c in "ab" {
        if c == "a" { first = fn() { c; }; } else { second = fn() { c; }; }
      }
      first() + second()`;
    expect(val(src)).toBe("ab");
  });

  it("lets a parameter shadow an outer variable", () => {
    expect(val("let x = 1; fn f(x) { x = x + 10; return x; } f(5) + x")).toBe(16);
  });
});

describe("interpreter: recursion", () => {
  it("computes factorial", () => {
    expect(val("fn fact(n) { if n <= 1 { return 1; } return n * fact(n - 1); } fact(10)")).toBe(3628800);
    expect(val("fn fact(n) { if n <= 1 { 1; } else { n * fact(n - 1); } } fact(5)")).toBe(120);
  });

  it("computes fibonacci", () => {
    const fib = "let fib = fn(n) { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); };";
    expect(val(`${fib} fib(0)`)).toBe(0);
    expect(val(`${fib} fib(1)`)).toBe(1);
    expect(val(`${fib} fib(10)`)).toBe(55);
    expect(val(`${fib} fib(20)`)).toBe(6765);
  });

  it("supports mutual recursion", () => {
    const src = `
      fn isEven(n) { if n == 0 { return true; } return isOdd(n - 1); }
      fn isOdd(n) { if n == 0 { return false; } return isEven(n - 1); }
      isEven(10) and isOdd(7) and !isEven(3)`;
    expect(val(src)).toBe(true);
  });

  it("recurses a few hundred levels deep", () => {
    expect(val("fn sum(n) { if n == 0 { return 0; } return n + sum(n - 1); } sum(300)")).toBe(45150);
  });
});

describe("safety: call depth limit", () => {
  it("stops infinite recursion with a friendly error", () => {
    const e = runtimeError("fn forever(n) { return forever(n + 1); }\nforever(0);");
    expect(e.message).toBe(
      `Maximum call depth of ${DEFAULT_MAX_CALL_DEPTH} exceeded. Is there a recursive function without a base case?`,
    );
    expect(e.trace).toHaveLength(DEFAULT_MAX_CALL_DEPTH + 1);
    expect(e.trace.at(-1)).toEqual({ name: "<main>", line: 2 });
    expect(e.trace[0]).toEqual({ name: "forever", line: 1 });
  });

  it("honours a custom limit and recovers afterwards", () => {
    const interp = new Interpreter({ out: () => {}, maxCallDepth: 10 });
    interp.runSource("fn down(n) { if n == 0 { return 0; } return down(n - 1); }");
    expect(interp.runSource("down(8)")).toBe(0);
    expect(() => interp.runSource("down(50)")).toThrow("Maximum call depth of 10 exceeded");
    // the call stack was unwound, so the same interpreter works again
    expect(interp.runSource("down(5)")).toBe(0);
  });

  it("turns a JavaScript stack overflow into a Curio error instead of crashing", () => {
    const e = runtimeError("fn f(n) { return f(n + 1); } f(0);", { maxCallDepth: 1e9 });
    expect(e.message).toBe("Stack overflow: the program nested too deeply");
    expect(e.line).toBeGreaterThan(0);
  });

  it("reports the limit for non-recursive depth too (mutual recursion)", () => {
    const e = runtimeError("fn a() { b(); } fn b() { a(); } a();", { maxCallDepth: 20 });
    expect(e.message).toContain("Maximum call depth of 20");
    expect(e.trace.slice(0, 2).map((f) => f.name)).toEqual(["b", "a"]);
  });
});

describe("runtime errors: line numbers and stack traces", () => {
  const src = [
    "fn divide(a, b) {", // 1
    "  return a / b;", // 2
    "}", // 3
    "fn compute(x) {", // 4
    "  let y = divide(x, 0);", // 5
    "  return y + 1;", // 6
    "}", // 7
    "print(\"start\");", // 8
    "compute(10);", // 9
  ].join("\n");

  it("lists each active function with the line it was on", () => {
    const e = runtimeError(src);
    expect(e.message).toBe("Division by zero");
    expect([e.line, e.col]).toEqual([2, 12]);
    expect(e.trace).toEqual([
      { name: "divide", line: 2 },
      { name: "compute", line: 5 },
      { name: "<main>", line: 9 },
    ]);
  });

  it("formats a readable report", () => {
    const text = runtimeError(src).format(src, "calc.curio");
    expect(text).toBe(
      [
        "runtime error: Division by zero",
        "  --> calc.curio:2:12",
        "  |",
        "2 |   return a / b;",
        "  |            ^",
        "",
        "Stack trace (most recent call first):",
        "  at divide (calc.curio:2)",
        "  at compute (calc.curio:5)",
        "  at <main> (calc.curio:9)",
      ].join("\n"),
    );
  });

  it("names anonymous functions", () => {
    const e = runtimeError("let r = fn() { return nope; };\nr();");
    expect(e.trace.map((f) => f.name)).toEqual(["r", "<main>"]);
    const e2 = runtimeError("fn() { return nope; }();");
    expect(e2.trace.map((f) => f.name)).toEqual(["<anonymous>", "<main>"]);
  });

  it("attaches the call site to errors raised by native functions", () => {
    const e = runtimeError("fn f() {\n  return fail();\n}\nf();", { setup: failing });
    expect(e.message).toBe("native failure");
    expect([e.line, e.col]).toEqual([2, 14]);
    expect(e.trace).toEqual([
      { name: "f", line: 2 },
      { name: "<main>", line: 4 },
    ]);
  });

  it("collapses very deep traces", () => {
    const s = "fn f(n) { return f(n + 1); }\nf(0);";
    const text = runtimeError(s).format(s, "deep.curio");
    expect(text).toContain("  ... 390 more calls ...");
    expect(text.split("\n").filter((l) => l.startsWith("  at ")).length).toBe(11);
    expect(text).toContain("at <main> (deep.curio:2)");
  });

  it("reports not-callable errors at the call", () => {
    const e = runtimeError("let a = 1;\na(2);");
    expect(e.message).toBe("Cannot call a value of type number");
    expect([e.line, e.col]).toEqual([2, 2]);
  });

  it("run() resets state after errors inside functions", () => {
    const interp = new Interpreter({ out: () => {} });
    interp.runSource("fn bad() { return missing; }");
    expect(() => interp.runSource("bad()")).toThrow("Undefined variable 'missing'");
    expect(run("1 + 1").value).toBe(2);
    expect(interp.runSource("1 + 1")).toBe(2);
  });
});
