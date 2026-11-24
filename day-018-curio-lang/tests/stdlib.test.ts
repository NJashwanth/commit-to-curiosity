import { describe, expect, it } from "vitest";
import { MAX_RANGE } from "../src/stdlib.js";
import { out, runtimeError, val } from "./helpers.js";

const err = (src: string) => runtimeError(src).message;

describe("stdlib: print, str, num, type, clock", () => {
  it("print joins arguments with spaces and ends the line", () => {
    expect(out('print("a", 1, [2], {k: nil});')).toBe('a 1 [2] {"k": nil}\n');
  });

  it("str converts anything to text", () => {
    expect(val("str(42)")).toBe("42");
    expect(val("str(1.5)")).toBe("1.5");
    expect(val('str("hi")')).toBe("hi");
    expect(val("str(nil)")).toBe("nil");
    expect(val("str(true)")).toBe("true");
    expect(val('str([1, "a"])')).toBe('[1, "a"]');
    expect(val("str(len)")).toBe("<native fn len>");
  });

  it("num parses numbers", () => {
    expect(val('num("42")')).toBe(42);
    expect(val('num("  3.5 ")')).toBe(3.5);
    expect(val('num("1e3")')).toBe(1000);
    expect(val('num("-7")')).toBe(-7);
    expect(val("num(5)")).toBe(5);
    expect(val("num(true)")).toBe(1);
    expect(val("num(false)")).toBe(0);
  });

  it("num explains what it could not convert", () => {
    expect(err('num("abc")')).toBe('Cannot convert "abc" to a number');
    expect(err('num("")')).toBe('Cannot convert "" to a number');
    expect(err("num(nil)")).toBe("Cannot convert a value of type nil to a number");
    expect(err("num([1])")).toBe("Cannot convert a value of type array to a number");
  });

  it("type names every kind of value", () => {
    expect(val('[type(1), type("s"), type(true), type(nil), type([]), type({}), type(len), type(fn() {})]')).toEqual([
      "number", "string", "bool", "nil", "array", "map", "function", "function",
    ]);
  });

  it("clock returns seconds as a number that does not go backwards", () => {
    const [a, b] = val("let a = clock(); let b = clock(); [a, b]") as number[];
    expect(typeof a).toBe("number");
    expect(a!).toBeGreaterThan(1.6e9);
    expect(b!).toBeGreaterThanOrEqual(a!);
  });
});

describe("stdlib: len", () => {
  it("measures strings, arrays and maps", () => {
    expect(val('len("hello")')).toBe(5);
    expect(val('len("")')).toBe(0);
    expect(val("len([1, 2, 3])")).toBe(3);
    expect(val("len({a: 1, b: 2})")).toBe(2);
  });

  it("rejects other types", () => {
    expect(err("len(5)")).toBe("len() expects a string, array or map as argument 1, got number");
    expect(err("len(nil)")).toBe("len() expects a string, array or map as argument 1, got nil");
  });
});

describe("stdlib: push and pop", () => {
  it("push appends in place and returns the array", () => {
    expect(val("let a = [1]; push(a, 2); push(a, [3]); a")).toEqual([1, 2, [3]]);
    expect(val("len(push([], 1))")).toBe(1);
  });

  it("pop removes and returns the last element", () => {
    expect(val("let a = [1, 2, 3]; let x = pop(a); [x, a]")).toEqual([3, [1, 2]]);
  });

  it("explains misuse", () => {
    expect(err("pop([])")).toBe("pop() called on an empty array");
    expect(err("push(1, 2)")).toBe("push() expects an array as argument 1, got number");
    expect(err("pop(nil)")).toBe("pop() expects an array as argument 1, got nil");
    expect(err("push([])")).toBe("push() takes 2 arguments but got 1");
  });
});

describe("stdlib: keys, values, has", () => {
  it("lists keys and values in insertion order", () => {
    expect(val("keys({b: 1, a: 2})")).toEqual(["b", "a"]);
    expect(val("values({b: 1, a: 2})")).toEqual([1, 2]);
    expect(val("keys({})")).toEqual([]);
  });

  it("has checks maps, arrays and strings", () => {
    expect(val('has({a: 1}, "a")')).toBe(true);
    expect(val('has({a: 1}, "b")')).toBe(false);
    expect(val("has({a: 1}, [1])")).toBe(false);
    expect(val("has([1, [2], 3], [2])")).toBe(true);
    expect(val("has([1, 2], 5)")).toBe(false);
    expect(val('has("hello", "ell")')).toBe(true);
    expect(val('has("hello", "xyz")')).toBe(false);
  });

  it("explains misuse", () => {
    expect(err("keys([1])")).toBe("keys() expects a map as argument 1, got array");
    expect(err("values(1)")).toBe("values() expects a map as argument 1, got number");
    expect(err("has(1, 2)")).toBe("has() expects an array, string or map as argument 1, got number");
    expect(err("has(\"a\", 1)")).toBe("has() expects a string as argument 2, got number");
  });
});

describe("stdlib: range", () => {
  it("counts up from zero, between two numbers, or by a step", () => {
    expect(val("range(4)")).toEqual([0, 1, 2, 3]);
    expect(val("range(0)")).toEqual([]);
    expect(val("range(-2)")).toEqual([]);
    expect(val("range(2, 5)")).toEqual([2, 3, 4]);
    expect(val("range(5, 2)")).toEqual([]);
    expect(val("range(0, 10, 3)")).toEqual([0, 3, 6, 9]);
    expect(val("range(5, 0, -2)")).toEqual([5, 3, 1]);
    expect(val("range(-3, 0)")).toEqual([-3, -2, -1]);
  });

  it("explains misuse and refuses absurd sizes", () => {
    expect(err("range(0, 5, 0)")).toBe("range() step cannot be 0");
    expect(err("range(1.5)")).toBe("range() expects a whole number as argument 1, got 1.5");
    expect(err('range("a")')).toBe("range() expects a number as argument 1, got string");
    expect(err("range(100000000)")).toContain(`more than ${MAX_RANGE.toLocaleString("en-US")} elements`);
    expect(err("range()")).toBe("range() takes 1 to 3 arguments but got 0");
  });
});

describe("stdlib: higher-order map, filter, reduce", () => {
  it("map transforms every element", () => {
    expect(val("map([1, 2, 3], fn(x) { x * x; })")).toEqual([1, 4, 9]);
    expect(val("map([], fn(x) { x })")).toEqual([]);
    expect(val('map(["a", "b"], str)')).toEqual(["a", "b"]);
    expect(val("map([1, 2], fn(x) { [x] })")).toEqual([[1], [2]]);
  });

  it("filter keeps elements whose result is truthy", () => {
    expect(val("filter([1, 2, 3, 4, 5, 6], fn(x) { x % 2 == 0; })")).toEqual([2, 4, 6]);
    expect(val("filter([0, 1, nil, 2, \"\", \"a\"], fn(x) { x })")).toEqual([1, 2, "a"]);
    expect(val("filter([1, 2], fn(x) { false })")).toEqual([]);
  });

  it("reduce folds with or without an initial value", () => {
    expect(val("reduce([1, 2, 3, 4], fn(a, x) { a + x; }, 0)")).toBe(10);
    expect(val("reduce([1, 2, 3, 4], fn(a, x) { a + x; })")).toBe(10);
    expect(val("reduce([2, 3, 4], fn(a, x) { a * x; }, 1)")).toBe(24);
    expect(val('reduce(["a", "b", "c"], fn(a, x) { a + x; }, "")')).toBe("abc");
    expect(val("reduce([], fn(a, x) { a + x; }, 7)")).toBe(7);
    expect(val("reduce([5], fn(a, x) { a + x; })")).toBe(5);
  });

  it("passes the index as a second argument when the callback asks for it", () => {
    expect(val("map([10, 20, 30], fn(x, i) { x + i; })")).toEqual([10, 21, 32]);
    expect(val("filter([5, 6, 7, 8], fn(x, i) { i % 2 == 0; })")).toEqual([5, 7]);
    expect(val("reduce([5, 6, 7], fn(acc, x, i) { acc + x * i; }, 0)")).toBe(20);
  });

  it("works on strings and maps (their characters and keys)", () => {
    expect(val('map("abc", fn(c) { c + c; })')).toEqual(["aa", "bb", "cc"]);
    expect(val("map({a: 1, b: 2}, fn(k) { k; })")).toEqual(["a", "b"]);
  });

  it("composes, as in the sample program", () => {
    expect(val("let nums = [1, 2, 3, 4, 5]; filter(map(nums, fn(x) { x * x; }), fn(x) { x > 5; })")).toEqual([9, 16, 25]);
    expect(out("print(filter(map([1, 2, 3, 4, 5], fn(x) { x * x; }), fn(x) { x > 5; }));")).toBe("[9, 16, 25]\n");
  });

  it("lets callbacks capture and mutate outer variables", () => {
    expect(val("let total = 0; map([1, 2, 3], fn(x) { total = total + x; }); total")).toBe(6);
  });

  it("explains misuse", () => {
    expect(err("map([1], 5)")).toBe("map() expects a function as argument 2, got number");
    expect(err("filter(5, fn(x) { x })")).toBe("filter() expects an array, string or map as argument 1, got number");
    expect(err("reduce([], fn(a, x) { a })")).toBe("reduce() of an empty collection needs an initial value as argument 3");
    expect(err("reduce([1], nil)")).toBe("reduce() expects a function as argument 2, got nil");
  });

  it("reports errors inside callbacks with the callback in the stack trace", () => {
    const e = runtimeError("let r = map([1, 0], fn(x) {\n  return 10 / x;\n});");
    expect(e.message).toBe("Division by zero");
    expect(e.line).toBe(2);
    expect(e.trace).toEqual([
      { name: "<anonymous>", line: 2 },
      { name: "<main>", line: 1 },
    ]);
  });
});

describe("stdlib: sort, slice, join, split", () => {
  it("sorts numbers and strings into a new array", () => {
    expect(val("sort([3, 1, 2])")).toEqual([1, 2, 3]);
    expect(val("sort([10, 9, 100])")).toEqual([9, 10, 100]);
    expect(val('sort(["b", "c", "a", "a"])')).toEqual(["a", "a", "b", "c"]);
    expect(val("let a = [2, 1]; let b = sort(a); a")).toEqual([2, 1]);
    expect(val("sort([])")).toEqual([]);
  });

  it("sorts with a comparison function", () => {
    expect(val("sort([1, 3, 2], fn(a, b) { b - a; })")).toEqual([3, 2, 1]);
    expect(val('sort(["bb", "a", "ccc"], fn(a, b) { len(b) - len(a); })')).toEqual(["ccc", "bb", "a"]);
  });

  it("explains sort misuse", () => {
    expect(err('sort([1, "a"])')).toBe("sort() needs all numbers or all strings, or a comparison function as argument 2");
    expect(err("sort([1, 2], fn(a, b) { nil })")).toBe("sort() comparison function must return a number, got nil");
    expect(err("sort([1], 5)")).toBe("sort() expects a function as argument 2, got number");
  });

  it("slices arrays and strings", () => {
    expect(val("slice([1, 2, 3, 4], 1, 3)")).toEqual([2, 3]);
    expect(val("slice([1, 2, 3, 4], 2)")).toEqual([3, 4]);
    expect(val("slice([1, 2, 3, 4], -2)")).toEqual([3, 4]);
    expect(val('slice("hello", 1, 3)')).toBe("el");
    expect(val('slice("hello", 3)')).toBe("lo");
    expect(err("slice(5, 1)")).toBe("slice() expects an array as argument 1, got number");
  });

  it("joins and splits text", () => {
    expect(val('join([1, "b", true], "-")')).toBe("1-b-true");
    expect(val("join([1, 2, 3])")).toBe("123");
    expect(val("join([])")).toBe("");
    expect(val('split("a,b,c", ",")')).toEqual(["a", "b", "c"]);
    expect(val('split("abc")')).toEqual(["a", "b", "c"]);
    expect(val('split("", ",")')).toEqual([""]);
    expect(val('split("a  b", " ")')).toEqual(["a", "", "b"]);
    expect(err('join([1], 2)')).toBe("join() expects a string as argument 2, got number");
    expect(err("split(1)")).toBe("split() expects a string as argument 1, got number");
  });

  it("changes case", () => {
    expect(val('upper("abC")')).toBe("ABC");
    expect(val('lower("ABc")')).toBe("abc");
    expect(err("upper(1)")).toBe("upper() expects a string as argument 1, got number");
  });
});

describe("stdlib: numbers", () => {
  it("floor, abs, sqrt", () => {
    expect(val("floor(3.7)")).toBe(3);
    expect(val("floor(-3.2)")).toBe(-4);
    expect(val("abs(-5)")).toBe(5);
    expect(val("abs(5)")).toBe(5);
    expect(val("sqrt(16)")).toBe(4);
    expect(err("sqrt(-1)")).toBe("sqrt() of a negative number (-1)");
    expect(err('floor("1")')).toBe("floor() expects a number as argument 1, got string");
  });

  it("min and max take several numbers or one array", () => {
    expect(val("min(3, 1, 2)")).toBe(1);
    expect(val("max(3, 1, 2)")).toBe(3);
    expect(val("min([4, 2, 8])")).toBe(2);
    expect(val("max([4, 2, 8])")).toBe(8);
    expect(val("max(5)")).toBe(5);
    expect(err("max([])")).toBe("max() of an empty array");
    expect(err('min(1, "a")')).toBe("min() expects a number as argument 2, got string");
  });
});

describe("stdlib: errors from natives point at the call", () => {
  it("reports line and column of the call and the enclosing function", () => {
    const src = "fn load(xs) {\n  return pop(xs);\n}\nload([]);";
    const e = runtimeError(src);
    expect(e.message).toBe("pop() called on an empty array");
    expect([e.line, e.col]).toEqual([2, 13]);
    expect(e.trace.map((f) => `${f.name}:${f.line}`)).toEqual(["load:2", "<main>:4"]);
  });
});
