// The standard library: native functions available to every Curio program.
//
//   output     print
//   values     len  str  num  type  clock
//   arrays     push  pop  slice  sort  join  range  has
//   maps       keys  values  has
//   higher     map  filter  reduce
//   text       split  join  upper  lower
//   numbers    floor  abs  sqrt  min  max

import type { Environment } from "./environment.js";
import { CurioRuntimeError } from "./errors.js";
import {
  CurioFunction,
  NativeFunction,
  isMapKey,
  isTruthy,
  stringify,
  typeOf,
  valuesEqual,
  type NativeContext,
  type Value,
} from "./values.js";

/** Most elements range() will build, so a typo cannot exhaust memory. */
export const MAX_RANGE = 10_000_000;

type Impl = (args: Value[], ctx: NativeContext) => Value;

function def(env: Environment, name: string, minArgs: number, maxArgs: number, fn: Impl): void {
  env.define(name, new NativeFunction(name, minArgs, maxArgs, fn));
}

// Natives throw location-less errors; the interpreter adds the call site and stack trace.
const fail = (message: string): never => {
  throw new CurioRuntimeError(message);
};

const badArg = (fn: string, n: number, expected: string, got: Value): never =>
  fail(`${fn}() expects ${expected} as argument ${n}, got ${typeOf(got)}`);

function arr(fn: string, n: number, v: Value): Value[] {
  return Array.isArray(v) ? v : badArg(fn, n, "an array", v);
}
function str(fn: string, n: number, v: Value): string {
  return typeof v === "string" ? v : badArg(fn, n, "a string", v);
}
function num(fn: string, n: number, v: Value): number {
  return typeof v === "number" ? v : badArg(fn, n, "a number", v);
}
function int(fn: string, n: number, v: Value): number {
  const x = num(fn, n, v);
  return Number.isInteger(x) ? x : fail(`${fn}() expects a whole number as argument ${n}, got ${x}`);
}
function func(fn: string, n: number, v: Value): Value {
  return v instanceof NativeFunction || v instanceof CurioFunction ? v : badArg(fn, n, "a function", v);
}

/** The items of something loopable: array elements, string characters or map keys. */
function items(fn: string, v: Value): Value[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (v instanceof Map) return [...v.keys()];
  return badArg(fn, 1, "an array, string or map", v);
}

/** Call a callback with as many of `args` as it declares parameters for (so `fn(x) {}` works in map). */
function callback(ctx: NativeContext, f: Value, args: Value[]): Value {
  const arity = f instanceof CurioFunction ? f.params.length : f instanceof NativeFunction ? f.maxArgs : args.length;
  return ctx.call(f, args.slice(0, arity));
}

export function installStdlib(env: Environment): void {
  // --- basics ------------------------------------------------------------
  def(env, "print", 0, Infinity, (args, ctx) => {
    ctx.out(args.map((a) => stringify(a)).join(" ") + "\n");
    return null;
  });

  def(env, "len", 1, 1, ([v]) => {
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    if (v instanceof Map) return v.size;
    return badArg("len", 1, "a string, array or map", v!);
  });

  def(env, "str", 1, 1, ([v]) => stringify(v!));

  def(env, "num", 1, 1, ([v]) => {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const n = v.trim() === "" ? NaN : Number(v);
      return Number.isNaN(n) ? fail(`Cannot convert ${stringify(v, true)} to a number`) : n;
    }
    return fail(`Cannot convert a value of type ${typeOf(v!)} to a number`);
  });

  def(env, "type", 1, 1, ([v]) => typeOf(v!));
  def(env, "clock", 0, 0, () => Date.now() / 1000);

  // --- arrays ------------------------------------------------------------
  def(env, "push", 2, 2, ([a, v]) => {
    arr("push", 1, a!).push(v!);
    return a!;
  });

  def(env, "pop", 1, 1, ([a]) => {
    const list = arr("pop", 1, a!);
    return list.length === 0 ? fail("pop() called on an empty array") : list.pop()!;
  });

  def(env, "range", 1, 3, (args) => {
    const nums = args.map((v, i) => int("range", i + 1, v));
    const [start, stop, step] = nums.length === 1 ? [0, nums[0]!, 1] : [nums[0]!, nums[1]!, nums[2] ?? 1];
    if (step === 0) fail("range() step cannot be 0");
    const count = Math.max(0, Math.ceil((stop! - start!) / step!));
    if (count > MAX_RANGE) fail(`range() is too large (more than ${MAX_RANGE.toLocaleString("en-US")} elements)`);
    return Array.from({ length: count }, (_, i) => start! + i * step!);
  });

  def(env, "slice", 2, 3, ([v, from, to]) => {
    const start = int("slice", 2, from!);
    const end = to === undefined ? undefined : int("slice", 3, to);
    if (typeof v === "string") return v.slice(start, end);
    return arr("slice", 1, v!).slice(start, end);
  });

  def(env, "sort", 1, 2, ([a, cmp], ctx) => {
    const copy = [...arr("sort", 1, a!)];
    if (cmp !== undefined) {
      func("sort", 2, cmp);
      return copy.sort((x, y) => {
        const r = ctx.call(cmp, [x, y]);
        return typeof r === "number" ? r : fail(`sort() comparison function must return a number, got ${typeOf(r)}`);
      });
    }
    if (copy.every((x) => typeof x === "number")) return (copy as number[]).sort((x, y) => x - y);
    if (copy.every((x) => typeof x === "string")) return (copy as string[]).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    return fail("sort() needs all numbers or all strings, or a comparison function as argument 2");
  });

  def(env, "join", 1, 2, ([a, sep]) =>
    arr("join", 1, a!)
      .map((x) => stringify(x))
      .join(sep === undefined ? "" : str("join", 2, sep)),
  );

  def(env, "has", 2, 2, ([c, x]) => {
    if (c instanceof Map) return isMapKey(x!) && c.has(x);
    if (Array.isArray(c)) return c.some((y) => valuesEqual(y, x!));
    if (typeof c === "string") return c.includes(str("has", 2, x!));
    return badArg("has", 1, "an array, string or map", c!);
  });

  // --- maps --------------------------------------------------------------
  const mapArg = (fn: string, v: Value) => (v instanceof Map ? v : badArg(fn, 1, "a map", v));
  def(env, "keys", 1, 1, ([m]) => [...mapArg("keys", m!).keys()]);
  def(env, "values", 1, 1, ([m]) => [...mapArg("values", m!).values()]);

  // --- higher-order ------------------------------------------------------
  def(env, "map", 2, 2, ([c, f], ctx) => {
    func("map", 2, f!);
    return items("map", c!).map((x, i) => callback(ctx, f!, [x, i]));
  });

  def(env, "filter", 2, 2, ([c, f], ctx) => {
    func("filter", 2, f!);
    return items("filter", c!).filter((x, i) => isTruthy(callback(ctx, f!, [x, i])));
  });

  def(env, "reduce", 2, 3, ([c, f, init], ctx) => {
    func("reduce", 2, f!);
    const list = items("reduce", c!);
    let acc: Value;
    let from = 0;
    if (init === undefined) {
      if (list.length === 0) return fail("reduce() of an empty collection needs an initial value as argument 3");
      acc = list[0]!;
      from = 1;
    } else {
      acc = init;
    }
    for (let i = from; i < list.length; i++) acc = callback(ctx, f!, [acc, list[i]!, i]);
    return acc;
  });

  // --- text --------------------------------------------------------------
  def(env, "split", 1, 2, ([s, sep]) => str("split", 1, s!).split(sep === undefined ? "" : str("split", 2, sep)));
  def(env, "upper", 1, 1, ([s]) => str("upper", 1, s!).toUpperCase());
  def(env, "lower", 1, 1, ([s]) => str("lower", 1, s!).toLowerCase());

  // --- numbers -----------------------------------------------------------
  def(env, "floor", 1, 1, ([n]) => Math.floor(num("floor", 1, n!)));
  def(env, "abs", 1, 1, ([n]) => Math.abs(num("abs", 1, n!)));
  def(env, "sqrt", 1, 1, ([n]) => {
    const x = num("sqrt", 1, n!);
    return x < 0 ? fail(`sqrt() of a negative number (${x})`) : Math.sqrt(x);
  });
  for (const [name, pick] of [["min", Math.min], ["max", Math.max]] as const) {
    def(env, name, 1, Infinity, (args) => {
      const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      if (list.length === 0) return fail(`${name}() of an empty array`);
      return pick(...list.map((v, i) => num(name, i + 1, v)));
    });
  }
}
