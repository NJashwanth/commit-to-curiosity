import { describe, expect, it } from "vitest";
import { Interpreter } from "../src/interpreter.js";
import { Environment } from "../src/environment.js";
import { NativeFunction, isTruthy, stringify, typeOf, valuesEqual } from "../src/values.js";
import { out, run, runtimeError, syntaxError, val } from "./helpers.js";

describe("interpreter: arithmetic", () => {
  it.each([
    ["1 + 2", 3],
    ["7 - 10", -3],
    ["6 * 7", 42],
    ["9 / 2", 4.5],
    ["9 % 4", 1],
    ["-5 % 3", -2],
    ["2 + 3 * 4", 14],
    ["(2 + 3) * 4", 20],
    ["10 - 4 - 3", 3],
    ["100 / 10 / 5", 2],
    ["-(2 + 3)", -5],
    ["--4", 4],
    ["0.1 + 0.2 > 0.3", true],
    ["1e3 + 1", 1001],
  ])("%s = %s", (src, expected) => {
    expect(val(src)).toBe(expected);
  });

  it("concatenates strings and coerces when one side is a string", () => {
    expect(val('"foo" + "bar"')).toBe("foobar");
    expect(val('"n = " + 5')).toBe("n = 5");
    expect(val('5 + " apples"')).toBe("5 apples");
    expect(val('"ok: " + true + nil')).toBe("ok: truenil");
  });

  it("reports division and modulo by zero at the operator", () => {
    const e = runtimeError("let a = 1;\nlet b = a / 0;");
    expect(e.message).toBe("Division by zero");
    expect([e.line, e.col]).toEqual([2, 11]);
    expect(runtimeError("5 % 0").message).toBe("Modulo by zero");
  });

  it("reports type errors with both operand types", () => {
    expect(runtimeError('"a" - 1').message).toBe("Operands of '-' must be numbers, got string and number");
    expect(runtimeError("nil * 2").message).toBe("Operands of '*' must be numbers, got nil and number");
    expect(runtimeError("true + false").message).toBe("Cannot add bool and bool");
    expect(runtimeError('-"x"').message).toBe("Operand of '-' must be a number, got string");
  });
});

describe("interpreter: comparisons and equality", () => {
  it.each([
    ["1 < 2", true],
    ["2 < 1", false],
    ["2 <= 2", true],
    ["3 > 2", true],
    ["2 >= 3", false],
    ['"apple" < "banana"', true],
    ['"b" > "a"', true],
    ['"a" <= "a"', true],
    ['"b" >= "c"', false],
    ["1 == 1", true],
    ["1 != 1", false],
    ['1 == "1"', false],
    ['"a" == "a"', true],
    ["nil == nil", true],
    ["nil == false", false],
    ["true == true", true],
    ["true != false", true],
    ["1 + 1 == 2", true],
  ])("%s is %s", (src, expected) => {
    expect(val(src)).toBe(expected);
  });

  it("rejects ordering across types", () => {
    expect(runtimeError('1 < "2"').message).toBe("Cannot compare number and string with '<'");
    expect(runtimeError("nil >= 1").message).toBe("Cannot compare nil and number with '>='");
  });
});

describe("interpreter: truthiness", () => {
  it("treats nil, false, 0 and the empty string as falsy", () => {
    for (const v of ["nil", "false", "0", '""']) expect(val(`!${v}`), v).toBe(true);
    for (const v of ["true", "1", "-1", '"a"', '" "', "0.5"]) expect(val(`!${v}`), v).toBe(false);
  });

  it("uses truthiness in if and while", () => {
    expect(out('if 0 { print("yes"); } else { print("no"); }')).toBe("no\n");
    expect(out('if "" { print("yes"); } else { print("no"); }')).toBe("no\n");
    expect(out('if "0" { print("yes"); } else { print("no"); }')).toBe("yes\n");
    expect(out("let n = 3; while n { print(n); n = n - 1; }")).toBe("3\n2\n1\n");
  });

  it("returns the deciding operand from and / or", () => {
    expect(val("nil or 5")).toBe(5);
    expect(val('0 or "x"')).toBe("x");
    expect(val("1 and 2")).toBe(2);
    expect(val("0 and 2")).toBe(0);
    expect(val("nil and boom")).toBe(null);
    expect(val("1 or boom")).toBe(1);
  });

  it("short-circuits so the right side only runs when needed", () => {
    expect(out('let t = 0; false and print("a"); true or print("b"); true and print("c"); false or print("d");')).toBe("c\nd\n");
  });

  it("exposes the value helpers", () => {
    expect(isTruthy(0)).toBe(false);
    expect(isTruthy("x")).toBe(true);
    expect(typeOf(null)).toBe("nil");
    expect(typeOf(true)).toBe("bool");
    expect(valuesEqual(1, 1)).toBe(true);
    expect(stringify("hi", true)).toBe('"hi"');
    expect(stringify("hi")).toBe("hi");
    expect(stringify(null)).toBe("nil");
    expect(stringify(1.5)).toBe("1.5");
    expect(stringify(new NativeFunction("f", 0, 0, () => null))).toBe("<native fn f>");
    expect(typeOf(new NativeFunction("f", 0, 0, () => null))).toBe("function");
  });
});

describe("interpreter: variables, scoping and shadowing", () => {
  it("declares, reads and reassigns variables", () => {
    expect(val("let x = 1; x = x + 1; x")).toBe(2);
    expect(val("let x; x")).toBe(null);
    expect(val("let a = 1; let b = a; a = 5; b")).toBe(1);
  });

  it("evaluates assignment as an expression, right to left", () => {
    expect(val("let a; let b; a = b = 7; a + b")).toBe(14);
    expect(val("let a = 0; (a = 4) + 1")).toBe(5);
  });

  it("allows redeclaring a name in the same scope", () => {
    expect(val("let x = 1; let x = x + 1; x")).toBe(2);
  });

  it("gives each block its own scope", () => {
    expect(val("let x = 1; { let x = 2; } x")).toBe(1);
    expect(runtimeError("{ let inner = 1; } inner").message).toBe("Undefined variable 'inner'");
  });

  it("shadows outer variables without changing them, and assigns to the nearest one", () => {
    expect(out("let x = 1; { let x = 2; print(x); { x = 3; print(x); } print(x); } print(x);")).toBe("2\n3\n3\n1\n");
    expect(val("let x = 1; { x = 9; } x")).toBe(9);
  });

  it("resolves the initializer before the new name exists", () => {
    expect(val("let x = 1; { let x = x + 10; x }")).toBe(11);
  });

  it("reports undefined variables on read and on assignment", () => {
    const e = runtimeError("let a = 1;\nprint(missing);");
    expect(e.message).toBe("Undefined variable 'missing'");
    expect([e.line, e.col]).toEqual([2, 7]);
    expect(runtimeError("nope = 1").message).toBe("Undefined variable 'nope' (declare it with let first)");
  });

  it("creates the Environment API correctly", () => {
    const outer = new Environment();
    outer.define("a", 1);
    const inner = new Environment(outer);
    inner.define("b", 2);
    expect(inner.get("a")).toBe(1);
    expect(outer.get("b")).toBeUndefined();
    expect(inner.assign("a", 5)).toBe(true);
    expect(outer.get("a")).toBe(5);
    expect(inner.assign("zzz", 1)).toBe(false);
    expect(inner.names()).toEqual(["b"]);
  });
});

describe("interpreter: if / else", () => {
  it("runs the matching branch", () => {
    expect(out("if 1 < 2 { print(1); } else { print(2); }")).toBe("1\n");
    expect(out("if 1 > 2 { print(1); } else { print(2); }")).toBe("2\n");
    expect(out("if false { print(1); }")).toBe("");
  });

  it("chains else if", () => {
    const grade = (n: number) =>
      out(`let n = ${n}; if n >= 90 { print("A"); } else if n >= 80 { print("B"); } else { print("C"); }`);
    expect(grade(95)).toBe("A\n");
    expect(grade(85)).toBe("B\n");
    expect(grade(10)).toBe("C\n");
  });

  it("yields the value of the branch taken", () => {
    expect(val("if true { 1; } else { 2; }")).toBe(1);
    expect(val("if false { 1; } else { 2; }")).toBe(2);
    expect(val("if false { 1; }")).toBe(null);
  });
});

describe("interpreter: loops", () => {
  it("runs while loops", () => {
    expect(val("let i = 0; let s = 0; while i < 5 { s = s + i; i = i + 1; } s")).toBe(10);
    expect(out("while false { print(1); }")).toBe("");
  });

  it("supports break and continue in while", () => {
    expect(out("let i = 0; while true { i = i + 1; if i > 3 { break; } print(i); }")).toBe("1\n2\n3\n");
    expect(out("let i = 0; while i < 5 { i = i + 1; if i % 2 == 0 { continue; } print(i); }")).toBe("1\n3\n5\n");
  });

  it("applies break and continue to the innermost loop only", () => {
    const src = `
      let i = 0;
      while i < 3 {
        i = i + 1;
        let j = 0;
        while true { j = j + 1; if j > 2 { break; } if j == 1 { continue; } print(i * 10 + j); }
      }`;
    expect(out(src)).toBe("12\n22\n32\n");
  });

  it("iterates over the characters of a string with for-in", () => {
    expect(out('for c in "abc" { print(c); }')).toBe("a\nb\nc\n");
    expect(out('for c in "" { print(c); }')).toBe("");
    expect(out('for c in "abcd" { if c == "b" { continue; } if c == "d" { break; } print(c); }')).toBe("a\nc\n");
  });

  it("keeps the loop variable out of the surrounding scope", () => {
    expect(runtimeError('for c in "ab" { } c').message).toBe("Undefined variable 'c'");
    expect(val('let c = 9; for c in "ab" { } c')).toBe(9);
  });

  it("rejects values that cannot be iterated", () => {
    const e = runtimeError("for x in 5 { }");
    expect(e.message).toBe("Cannot loop over a value of type number");
  });

  it("stops runaway loops when a step limit is set", () => {
    const e = runtimeError("while true { }", { maxSteps: 1000 });
    expect(e.message).toContain("Execution limit of 1000 steps exceeded");
  });
});

describe("interpreter: program results and state", () => {
  it("returns the value of the last statement", () => {
    expect(val("1; 2; 3")).toBe(3);
    expect(val("let a = 1;")).toBe(null);
    expect(val("")).toBe(null);
    expect(val("{ 4; 5; }")).toBe(5);
  });

  it("keeps global state between runs of the same interpreter (what the REPL relies on)", () => {
    let printed = "";
    const interp = new Interpreter({ out: (t) => (printed += t) });
    interp.runSource("let total = 10;");
    interp.runSource("total = total + 5;");
    expect(interp.runSource("total")).toBe(15);
    interp.runSource("print(total);");
    expect(printed).toBe("15\n");
  });

  it("recovers cleanly after a runtime error", () => {
    const interp = new Interpreter({ out: () => {} });
    interp.runSource("let keep = 1;");
    expect(() => interp.runSource("{ let tmp = 2; boom; }")).toThrow("Undefined variable 'boom'");
    expect(interp.runSource("keep")).toBe(1);
    expect(() => interp.runSource("tmp")).toThrow("Undefined variable 'tmp'");
  });

  it("throws syntax errors with all diagnostics before running anything", () => {
    const e = syntaxError("print(1);\nlet a = ;\nlet b = ;");
    expect(e.diagnostics).toHaveLength(2);
    let printed = "";
    expect(() => new Interpreter({ out: (t) => (printed += t) }).runSource("print(1); let = ;")).toThrow();
    expect(printed).toBe("");
  });

  it("prints several values separated by spaces", () => {
    expect(out('print("a", 1, true, nil);')).toBe("a 1 true nil\n");
    expect(out("print();")).toBe("\n");
  });
});

describe("interpreter: calling things", () => {
  it("checks native arity", () => {
    expect(runtimeError("print(1)(2)").message).toBe("Cannot call a value of type nil");
    expect(runtimeError("let x = 5; x()").message).toBe("Cannot call a value of type number");
  });

  it("run() returns the completion value and exposes globals", () => {
    const interp = new Interpreter({ out: () => {} });
    expect(interp.globals.get("print")).toBeInstanceOf(NativeFunction);
    expect(run("1 + 1").value).toBe(2);
  });
});

describe("interpreter: runtime error formatting", () => {
  it("shows the source line, a caret and the trace", () => {
    const src = "let a = 1;\nlet b = a / 0;";
    const text = runtimeError(src).format(src, "demo.curio");
    expect(text).toBe(
      [
        "runtime error: Division by zero",
        "  --> demo.curio:2:11",
        "  |",
        "2 | let b = a / 0;",
        "  |           ^",
        "",
        "Stack trace (most recent call first):",
        "  at <main> (demo.curio:2)",
      ].join("\n"),
    );
  });
});
