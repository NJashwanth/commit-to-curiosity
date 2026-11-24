import { describe, expect, it } from "vitest";
import { toSexpr } from "../src/ast.js";
import { parseExpr } from "../src/parser.js";

const sexpr = (src: string): string => {
  const r = parseExpr(src);
  expect(r.errors, `unexpected errors for ${src}`).toEqual([]);
  return toSexpr(r.expr!);
};

describe("parser: literals and primaries", () => {
  it.each([
    ["42", "42"],
    ["3.5", "3.5"],
    ['"hi"', '"hi"'],
    ["true", "true"],
    ["false", "false"],
    ["nil", "nil"],
    ["name", "name"],
    ["(7)", "7"],
    ["((x))", "x"],
  ])("%s", (src, expected) => {
    expect(sexpr(src)).toBe(expected);
  });
});

describe("parser: precedence (tight binds first)", () => {
  // Each row is a pair of source and the fully parenthesised tree it must produce.
  it.each([
    ["1 + 2 * 3", "(+ 1 (* 2 3))"],
    ["1 * 2 + 3", "(+ (* 1 2) 3)"],
    ["1 + 2 % 3", "(+ 1 (% 2 3))"],
    ["(1 + 2) * 3", "(* (+ 1 2) 3)"],
    ["a < b + c", "(< a (+ b c))"],
    ["a + b < c * d", "(< (+ a b) (* c d))"],
    ["a == b < c", "(== a (< b c))"],
    ["a < b == c < d", "(== (< a b) (< c d))"],
    ["a != b == c", "(== (!= a b) c)"],
    ["a and b == c", "(and a (== b c))"],
    ["a or b and c", "(or a (and b c))"],
    ["a and b or c and d", "(or (and a b) (and c d))"],
    ["x = a or b", "(= x (or a b))"],
    ["x = y + 1", "(= x (+ y 1))"],
    ["-a * b", "(* (- a) b)"],
    ["-a + -b", "(+ (- a) (- b))"],
    ["!a == b", "(== (! a) b)"],
    ["!a and !b", "(and (! a) (! b))"],
    ["-f(x)", "(- (call f x))"],
    ["!a[0]", "(! (index a 0))"],
    ["-a[0] * 2", "(* (- (index a 0)) 2)"],
    ["f(1 + 2, 3 * 4)", "(call f (+ 1 2) (* 3 4))"],
    ["a + f(b) * c", "(+ a (* (call f b) c))"],
    ["a[i + 1] + 1", "(+ (index a (+ i 1)) 1)"],
    ["a[0] = b[1] + 2", "(= (index a 0) (+ (index b 1) 2))"],
  ])("%s  =>  %s", (src, expected) => {
    expect(sexpr(src)).toBe(expected);
  });
});

describe("parser: associativity", () => {
  it.each([
    ["1 - 2 - 3", "(- (- 1 2) 3)"],
    ["8 / 4 / 2", "(/ (/ 8 4) 2)"],
    ["1 + 2 - 3 + 4", "(+ (- (+ 1 2) 3) 4)"],
    ["a * b / c % d", "(% (/ (* a b) c) d)"],
    ["a < b < c", "(< (< a b) c)"],
    ["a == b == c", "(== (== a b) c)"],
    ["a or b or c", "(or (or a b) c)"],
    ["a and b and c", "(and (and a b) c)"],
    ["a = b = c", "(= a (= b c))"],
    ["a = b = c = 1", "(= a (= b (= c 1)))"],
    ["--a", "(- (- a))"],
    ["!!a", "(! (! a))"],
    ["f(1)(2)(3)", "(call (call (call f 1) 2) 3)"],
    ["a[1][2]", "(index (index a 1) 2)"],
    ["f(1)[2](3)", "(call (index (call f 1) 2) 3)"],
  ])("%s  =>  %s", (src, expected) => {
    expect(sexpr(src)).toBe(expected);
  });
});

describe("parser: calls and indexing", () => {
  it("parses empty argument lists and trailing commas", () => {
    expect(sexpr("f()")).toBe("(call f)");
    expect(sexpr("f(1, 2,)")).toBe("(call f 1 2)");
  });

  it("allows an assignment inside call arguments and indexes", () => {
    expect(sexpr("f(a = 1)")).toBe("(call f (= a 1))");
    expect(sexpr("a[b = 0]")).toBe("(index a (= b 0))");
  });

  it("puts a call at the position of its open paren and a binary at its operator", () => {
    const call = parseExpr("  foo(1)").expr!;
    expect(call.pos).toEqual({ line: 1, col: 6 });
    const bin = parseExpr("1\n  + 2").expr!;
    expect(bin.pos).toEqual({ line: 2, col: 3 });
    expect(parseExpr("a[0]").expr!.pos).toEqual({ line: 1, col: 2 });
    expect(parseExpr("x = 1").expr!.pos).toEqual({ line: 1, col: 3 });
    expect(parseExpr("-1").expr!.pos).toEqual({ line: 1, col: 1 });
  });
});

describe("parser: expression errors", () => {
  it("reports a missing operand with line and column", () => {
    const r = parseExpr("1 +");
    expect(r.expr).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      message: "Expected expression, found end of input",
      line: 1,
      col: 4,
      atEof: true,
    });
  });

  it("reports an operator where an operand should be, without consuming it", () => {
    const r = parseExpr("1 + * 2");
    expect(r.errors[0]).toMatchObject({ message: "Expected expression, found '*'", line: 1, col: 5, length: 1 });
  });

  it("reports an unclosed group or call", () => {
    expect(parseExpr("(1 + 2").errors[0]!.message).toBe("Expected ')' after expression, found end of input");
    expect(parseExpr("f(1, 2").errors[0]!.message).toBe("Expected ')' after arguments, found end of input");
    expect(parseExpr("f(1 2)").errors[0]!.message).toBe("Expected ')' after arguments, found number 2");
    expect(parseExpr("a[1").errors[0]!.message).toBe("Expected ']' after index, found end of input");
  });

  it("reports trailing tokens after a complete expression", () => {
    const r = parseExpr("1 2");
    expect(r.errors[0]).toMatchObject({ message: "Unexpected number 2 after expression", col: 3 });
  });

  it("rejects invalid assignment targets but keeps parsing", () => {
    for (const src of ["1 = 2", "a + b = c", "f() = 1", "-a = 1", "(a == b) = 1"]) {
      const r = parseExpr(src);
      expect(r.errors, src).toHaveLength(1);
      expect(r.errors[0]!.message).toBe("Invalid assignment target");
    }
    const r = parseExpr("1 = 2");
    expect(r.errors[0]).toMatchObject({ line: 1, col: 3 });
  });

  it("does not report a lexer error twice, and orders mixed errors by position", () => {
    expect(parseExpr("1 + @").errors.map((e) => e.message)).toEqual(["Unexpected character '@'"]);
    expect(parseExpr("1 + ) @").errors.map((e) => `${e.col} ${e.message}`)).toEqual([
      "5 Expected expression, found ')'",
      "7 Unexpected character '@'",
    ]);
  });
});
