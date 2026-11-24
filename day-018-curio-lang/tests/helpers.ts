import { Interpreter, type InterpreterOptions } from "../src/interpreter.js";
import { CurioRuntimeError, CurioSyntaxError } from "../src/errors.js";
import type { Value } from "../src/values.js";

export interface RunResult {
  value: Value;
  output: string;
}

/** Run a program in a fresh interpreter, capturing everything it prints. */
export function run(source: string, options: InterpreterOptions = {}): RunResult {
  let output = "";
  const interp = new Interpreter({ ...options, out: (t) => (output += t) });
  const value = interp.runSource(source);
  return { value, output };
}

/** The value of the program's last statement. */
export const val = (source: string, options: InterpreterOptions = {}): Value => run(source, options).value;

/** Everything the program prints. */
export const out = (source: string, options: InterpreterOptions = {}): string => run(source, options).output;

/** Run a program that must fail at runtime and return the error. */
export function runtimeError(source: string, options: InterpreterOptions = {}): CurioRuntimeError {
  try {
    run(source, options);
  } catch (e) {
    if (e instanceof CurioRuntimeError) return e;
    throw e;
  }
  throw new Error(`expected a runtime error from: ${source}`);
}

/** Run a program that must fail to parse and return the error. */
export function syntaxError(source: string): CurioSyntaxError {
  try {
    run(source);
  } catch (e) {
    if (e instanceof CurioSyntaxError) return e;
    throw e;
  }
  throw new Error(`expected a syntax error from: ${source}`);
}
