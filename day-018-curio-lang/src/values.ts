// Runtime values and the rules about them: truthiness, equality, type names, printing.

import type { Block } from "./ast.js";
import type { Environment } from "./environment.js";

/** What a native (TypeScript) function can ask the interpreter to do. */
export interface NativeContext {
  /** Write text to the program's output. */
  out(text: string): void;
  /** Call a Curio function (or another native) and get its result. */
  call(fn: Value, args: Value[]): Value;
}

/** A function implemented in TypeScript and exposed to Curio programs. */
export class NativeFunction {
  constructor(
    readonly name: string,
    readonly minArgs: number,
    readonly maxArgs: number,
    readonly fn: (args: Value[], ctx: NativeContext) => Value,
  ) {}
}

/** A function defined in Curio code, together with the scope it was created in (its closure). */
export class CurioFunction {
  constructor(
    readonly name: string | null,
    readonly params: string[],
    readonly body: Block,
    readonly closure: Environment,
  ) {}
}

/** Map keys must be plain values so they have an obvious identity. */
export type MapKey = string | number | boolean;
export type CurioMap = Map<MapKey, Value>;

/** nil is represented as null; arrays are JS arrays; maps are JS Maps (insertion ordered). */
export type Value = number | string | boolean | null | NativeFunction | CurioFunction | Value[] | CurioMap;

export function isMapKey(v: Value): v is MapKey {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

export function typeOf(v: Value): string {
  if (v === null) return "nil";
  if (Array.isArray(v)) return "array";
  if (v instanceof Map) return "map";
  switch (typeof v) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "bool";
    default:
      return "function";
  }
}

/** Falsy values: nil, false, 0 and "". Everything else (including empty collections) is truthy. */
export function isTruthy(v: Value): boolean {
  return v !== null && v !== false && v !== 0 && v !== "";
}

/** Structural equality for arrays and maps; identity for functions; strict for primitives. */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]!));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !valuesEqual(v, b.get(k)!)) return false;
    return true;
  }
  return false;
}

/** Text form of a value. Strings are bare (`str`) or quoted (`repr`, used inside collections and the REPL). */
export function stringify(v: Value, quoteStrings = false, seen: Set<object> = new Set()): string {
  if (v === null) return "nil";
  if (typeof v === "string") return quoteStrings ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof NativeFunction) return `<native fn ${v.name}>`;
  if (v instanceof CurioFunction) return `<fn ${v.name ?? "anonymous"}>`;
  if (seen.has(v)) return Array.isArray(v) ? "[...]" : "{...}";
  seen.add(v);
  try {
    if (Array.isArray(v)) return `[${v.map((x) => stringify(x, true, seen)).join(", ")}]`;
    const items = [...v].map(([k, x]) => `${stringify(k, true)}: ${stringify(x, true, seen)}`);
    return `{${items.join(", ")}}`;
  } finally {
    seen.delete(v);
  }
}
