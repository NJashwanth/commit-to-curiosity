import { describe, expect, it } from "vitest";
import { dumpAst, toSexpr } from "../src/ast.js";
import { parse, parseExpr } from "../src/parser.js";
import { stringify, valuesEqual, typeOf, type Value } from "../src/values.js";
import { out, runtimeError, val } from "./helpers.js";

const lines = (...l: string[]) => l.join("\n");
const messages = (src: string) => parse(src).errors.map((e) => `${e.line}:${e.col} ${e.message}`);
const show = (src: string) => stringify(val(src), true);

describe("parser: array, map and template literals", () => {
  it("parses arrays", () => {
    expect(toSexpr(parseExpr("[]").expr!)).toBe("(array)");
    expect(toSexpr(parseExpr("[1, 2 + 3, [4]]").expr!)).toBe("(array 1 (+ 2 3) (array 4))");
    expect(toSexpr(parseExpr("[1, 2,]").expr!)).toBe("(array 1 2)");
    expect(dumpAst(parse("[1, x];").program)).toBe(
      lines("Program", "  ExprStmt", "    Array", "      Number 1", "      Ident x"),
    );
  });

  it("parses maps, with bare identifiers as string keys", () => {
    expect(toSexpr(parseExpr("{}").expr!)).toBe("(map)");
    expect(toSexpr(parseExpr('{"a": 1, b: 2, 3: x,}').expr!)).toBe('(map "a" 1 "b" 2 3 x)');
    expect(toSexpr(parseExpr("{(k): 1}").expr!)).toBe("(map k 1)");
    expect(dumpAst(parse("let m = {a: 1};").program)).toBe(
      lines("Program", "  Let m", "    Map", "      key: String \"a\"", "      value: Number 1"),
    );
  });

  it("treats a { at the start of a statement as a block, unless it starts with `key:`", () => {
    expect(parse("{ 1; }").program.body[0]!.kind).toBe("Block");
    expect(parse("{}").program.body[0]!.kind).toBe("Block");
    expect(parse("{ a: 1 }").program.body[0]!.kind).toBe("ExprStmt");
    expect(parse('{ "a": 1 }').program.body[0]!.kind).toBe("ExprStmt");
    expect(parse("{ 1: 1 }").program.body[0]!.kind).toBe("ExprStmt");
    expect(parse("{ true: 1 }").program.body[0]!.kind).toBe("ExprStmt");
    expect(parse("{ a; }").program.body[0]!.kind).toBe("Block");
    expect(parse("let m = { a: 1 };").program.body[0]!.kind).toBe("Let");
    expect(parse("return_it({ a: 1 });").errors).toEqual([]);
  });

  it("parses templates into text and expressions", () => {
    expect(toSexpr(parseExpr('"a ${x} b ${1 + 2}"').expr!)).toBe('(template "a " x " b " (+ 1 2))');
    expect(dumpAst(parse('"hi ${name}";').program)).toBe(
      lines("Program", "  ExprStmt", "    Template", '      String "hi "', "      expr: Ident name"),
    );
  });

  it("parses nested templates, maps and functions inside an interpolation", () => {
    expect(parseExpr('"${"in ${x}"}"').errors).toEqual([]);
    expect(parseExpr('"${ {"k": 1}["k"] }"').errors).toEqual([]);
    expect(parseExpr('"${fn(a) { return a; }(1)}"').errors).toEqual([]);
  });

  it("recovers after a bad map literal without extra errors", () => {
    expect(messages("let m = {a 1}; let y = 2;")).toEqual(["1:12 Expected ':' after map key, found number 1"]);
    expect(messages("if x { let m = {a 1}; let z = 3; }")).toEqual(["1:19 Expected ':' after map key, found number 1"]);
    expect(messages("f({a 1}); let z = ;")).toHaveLength(2);
    expect(messages("let m = {a: 1;\nlet y = ;")).toHaveLength(2);
  });

  it("reports mistakes in literals with positions", () => {
    expect(messages("[1, 2")).toEqual(["1:6 Expected ']' after array elements, found end of input"]);
    expect(messages("[1 2];")).toEqual(["1:4 Expected ']' after array elements, found number 2"]);
    expect(messages("let m = {a 1};")).toEqual(["1:12 Expected ':' after map key, found number 1"]);
    expect(messages("let m = {a: 1;")).toEqual(["1:14 Expected '}' after map entries, found ';'"]);
    expect(messages("let m = {a: ")).toEqual(["1:13 Expected expression, found end of input"]);
  });

  it("reports mistakes inside interpolations at their real position", () => {
    expect(messages('print("a ${}");')).toEqual(["1:12 Expected an expression inside '${}'"]);
    expect(messages('print("a ${1 +}");')).toEqual(["1:15 Expected expression, found end of input"]);
    expect(messages('print("a ${1 2}");')).toEqual(["1:14 Unexpected number 2 in string interpolation"]);
    expect(messages('print("a ${x')).toEqual(["1:10 Unterminated string interpolation, expected '}'"]);
  });
});

describe("arrays", () => {
  it("builds, indexes and measures arrays", () => {
    expect(val("[10, 20, 30][1]")).toBe(20);
    expect(val("let a = [1, [2, 3]]; a[1][0]")).toBe(2);
    expect(val("len([1, 2, 3])")).toBe(3);
    expect(val("len([])")).toBe(0);
  });

  it("indexes from the end with negative numbers", () => {
    expect(val("[1, 2, 3][-1]")).toBe(3);
    expect(val("[1, 2, 3][-3]")).toBe(1);
  });

  it("assigns by index, and the change is visible through every reference", () => {
    expect(val("let a = [1, 2, 3]; a[1] = 9; a")).toEqual([1, 9, 3]);
    expect(val("let a = [1, 2]; let b = a; b[0] = 7; a[0]")).toBe(7);
    expect(val("let a = [0, 0]; a[-1] = 5; a")).toEqual([0, 5]);
    expect(val("let a = [[1], [2]]; a[1][0] = 8; a")).toEqual([[1], [8]]);
    expect(val("let a = [1]; (a[0] = 4) + 1")).toBe(5);
  });

  it("concatenates arrays with + into a new array", () => {
    expect(val("let a = [1]; let b = a + [2, 3]; a")).toEqual([1]);
    expect(val("[1] + [2, 3]")).toEqual([1, 2, 3]);
    expect(runtimeError("[1] + 2").message).toBe("Cannot add array and number");
  });

  it("compares arrays by value", () => {
    expect(val("[1, 2] == [1, 2]")).toBe(true);
    expect(val("[1, 2] == [1, 3]")).toBe(false);
    expect(val("[1, [2]] == [1, [2]]")).toBe(true);
    expect(val("[1] == [1, 2]")).toBe(false);
    expect(val("[] != []")).toBe(false);
    expect(val("[1] == 1")).toBe(false);
  });

  it("is truthy even when empty", () => {
    expect(val("[] and 1")).toBe(1);
  });

  it("reports out-of-range indexes with the length", () => {
    const e = runtimeError("let a = [1, 2, 3];\nprint(a[3]);");
    expect(e.message).toBe("Index 3 is out of range for array of length 3");
    expect([e.line, e.col]).toEqual([2, 8]);
    expect(runtimeError("[1, 2, 3][-4]").message).toBe("Index -4 is out of range for array of length 3");
    expect(runtimeError("[][0]").message).toBe("Index 0 is out of range for array of length 0");
    expect(runtimeError("let a = [1]; a[5] = 1;").message).toBe("Index 5 is out of range for array of length 1");
  });

  it("rejects bad index types", () => {
    expect(runtimeError('[1]["0"]').message).toBe("Array index must be a number, got string");
    expect(runtimeError("[1, 2][0.5]").message).toBe("Array index must be a whole number, got 0.5");
    expect(runtimeError("nil[0]").message).toBe("Cannot index a value of type nil");
    expect(runtimeError("5[0] = 1").message).toBe("Cannot assign into a value of type number");
  });

  it("prints arrays readably", () => {
    expect(out('print([1, "a", true, nil, [2]]);')).toBe('[1, "a", true, nil, [2]]\n');
    expect(out("print([]);")).toBe("[]\n");
  });
});

describe("strings as sequences", () => {
  it("indexes characters", () => {
    expect(val('"hello"[1]')).toBe("e");
    expect(val('"hello"[-1]')).toBe("o");
    expect(runtimeError('"hi"[2]').message).toBe("Index 2 is out of range for string of length 2");
  });

  it("is immutable", () => {
    expect(runtimeError('let s = "abc"; s[0] = "x";').message).toBe("Strings are immutable: cannot assign to an index of a string");
  });
});

describe("maps", () => {
  it("builds, reads and writes maps", () => {
    expect(val('{"a": 1, "b": 2}["b"]')).toBe(2);
    expect(val("{a: 1}[\"a\"]")).toBe(1);
    expect(val("let m = {}; m[\"x\"] = 5; m[\"x\"]")).toBe(5);
    expect(val('let m = {a: 1}; m["a"] = m["a"] + 1; m["a"]')).toBe(2);
    expect(val("let m = {1: \"one\", true: \"yes\"}; m[1] + m[true]")).toBe("oneyes");
    expect(val("len({a: 1, b: 2})")).toBe(2);
  });

  it("keeps insertion order and overwrites in place", () => {
    expect(show('let m = {b: 1, a: 2}; m["c"] = 3; m["b"] = 9; m')).toBe('{"b": 9, "a": 2, "c": 3}');
  });

  it("evaluates keys and values in order and allows computed keys", () => {
    expect(out('let m = {(print(1) or "k"): print(2)};')).toBe("1\n2\n");
    expect(val('let k = "dyn"; let m = {(k): 1}; m["dyn"]')).toBe(1);
  });

  it("shares maps by reference and compares them by value", () => {
    expect(val('let a = {x: 1}; let b = a; b["x"] = 2; a["x"]')).toBe(2);
    expect(val("{a: 1, b: 2} == {b: 2, a: 1}")).toBe(true);
    expect(val("{a: 1} == {a: 2}")).toBe(false);
    expect(val("{a: 1} == {a: 1, b: 2}")).toBe(false);
    expect(val("{a: 1} == {c: 1}")).toBe(false);
    expect(val("{a: 1} == 1")).toBe(false);
  });

  it("reports a missing key", () => {
    const e = runtimeError('let m = {a: 1};\nm["zzz"];');
    expect(e.message).toBe('Key "zzz" not found in map');
    expect([e.line, e.col]).toEqual([2, 2]);
    expect(runtimeError("({})[5]").message).toBe("Key 5 not found in map");
  });

  it("rejects keys that are not strings, numbers or booleans", () => {
    expect(runtimeError("({[1]: 2})").message).toBe("Map keys must be strings, numbers or booleans, got array");
    expect(runtimeError("{a: 1}[nil]").message).toBe("Map keys must be strings, numbers or booleans, got nil");
    expect(runtimeError("let m = {}; m[[1]] = 1;").message).toBe("Map keys must be strings, numbers or booleans, got array");
  });

  it("prints maps readably", () => {
    expect(out('print({a: 1, "b c": [1, 2]});')).toBe('{"a": 1, "b c": [1, 2]}\n');
    expect(out("print({});")).toBe("{}\n");
  });
});

describe("value helpers for collections", () => {
  it("names types", () => {
    expect(typeOf([] as Value)).toBe("array");
    expect(typeOf(new Map())).toBe("map");
  });

  it("stringifies recursive structures without looping forever", () => {
    const a: Value[] = [1];
    a.push(a);
    expect(stringify(a, true)).toBe("[1, [...]]");
    const m = new Map<string, Value>();
    m.set("self", m);
    expect(stringify(m, true)).toBe('{"self": {...}}');
    expect(valuesEqual(a, a)).toBe(true);
  });

  it("shows functions inside collections", () => {
    expect(show("[print, fn() {}]")).toBe("[<native fn print>, <fn anonymous>]");
  });
});

describe("string interpolation", () => {
  it("embeds expressions", () => {
    expect(val('"1 + 2 = ${1 + 2}"')).toBe("1 + 2 = 3");
    expect(val('let name = "Ada"; "hi ${name}!"')).toBe("hi Ada!");
    expect(val('"${1}${2}${3}"')).toBe("123");
    expect(val('"${"x"}"')).toBe("x");
  });

  it("stringifies every kind of value", () => {
    expect(val('"${nil} ${true} ${[1, "a"]} ${{k: 1}} ${1.5}"')).toBe('nil true [1, "a"] {"k": 1} 1.5');
  });

  it("supports calls, indexes, nested strings and braces inside the expression", () => {
    expect(val('let xs = [4, 5]; "n=${len(xs)} first=${xs[0]}"')).toBe("n=2 first=4");
    expect(val('let a = "b"; "x ${"inner ${a}"} y"')).toBe("x inner b y");
    expect(val('"v: ${ {"k": 7}["k"] }"')).toBe("v: 7");
    expect(val('"${fn(n) { return n * 2; }(4)}"')).toBe("8");
  });

  it("evaluates left to right and only when reached", () => {
    expect(out('let s = "${print(1)}${print(2)}";')).toBe("1\n2\n");
  });

  it("keeps escapes and a literal dollar", () => {
    expect(val('"cost: \\${5} or $5"')).toBe("cost: ${5} or $5");
    expect(val('"a\\tb"')).toBe("a\tb");
  });

  it("reports runtime errors inside an interpolation at their line", () => {
    const e = runtimeError('let a = 1;\nprint("v ${missing}");');
    expect(e.message).toBe("Undefined variable 'missing'");
    expect([e.line, e.col]).toEqual([2, 12]);
  });
});

describe("for-in over arrays, maps, strings and ranges", () => {
  it("loops over arrays in order", () => {
    expect(out("for x in [3, 1, 2] { print(x); }")).toBe("3\n1\n2\n");
    expect(val("let s = 0; for x in [1, 2, 3, 4] { s = s + x; } s")).toBe(10);
    expect(out("for x in [] { print(x); }")).toBe("");
  });

  it("loops over ranges", () => {
    expect(out("for i in range(3) { print(i); }")).toBe("0\n1\n2\n");
    expect(out("for i in range(2, 5) { print(i); }")).toBe("2\n3\n4\n");
    expect(out("for i in range(10, 0, -4) { print(i); }")).toBe("10\n6\n2\n");
    expect(out("for i in range(5, 5) { print(i); }")).toBe("");
  });

  it("loops over map keys", () => {
    expect(out('let m = {a: 1, b: 2}; for k in m { print(k, m[k]); }')).toBe("a 1\nb 2\n");
  });

  it("supports break and continue", () => {
    expect(out("for i in range(10) { if i % 2 == 1 { continue; } if i > 6 { break; } print(i); }")).toBe("0\n2\n4\n6\n");
  });

  it("is not affected by pushing to the array inside the loop", () => {
    expect(val("let a = [1, 2]; for x in a { push(a, x * 10); } len(a)")).toBe(4);
  });

  it("allows return from inside a for-in in a function", () => {
    expect(val("fn find(xs, t) { for x in xs { if x == t { return true; } } return false; } find([1, 2, 3], 2) and !find([1], 5)")).toBe(true);
  });
});
