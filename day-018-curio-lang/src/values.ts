// Runtime values and the rules about them: truthiness, equality, type names, printing.

/** What a native (TypeScript) function can ask the interpreter to do. */
export interface NativeContext {
  /** Write text to the program's output. */
  out(text: string): void;
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

/** nil is represented as null. */
export type Value = number | string | boolean | null | NativeFunction;

export function typeOf(v: Value): string {
  if (v === null) return "nil";
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

/** Falsy values: nil, false, 0 and "". Everything else is truthy. */
export function isTruthy(v: Value): boolean {
  return v !== null && v !== false && v !== 0 && v !== "";
}

export function valuesEqual(a: Value, b: Value): boolean {
  return a === b;
}

/** Text form of a value. Strings are bare (`str`) or quoted (`repr`, used inside collections and the REPL). */
export function stringify(v: Value, quoteStrings = false): string {
  if (v === null) return "nil";
  switch (typeof v) {
    case "number":
    case "boolean":
      return String(v);
    case "string":
      return quoteStrings ? JSON.stringify(v) : v;
    default:
      return `<native fn ${v.name}>`;
  }
}
