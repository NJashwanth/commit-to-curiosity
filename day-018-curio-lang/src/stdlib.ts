// The standard library: native functions available to every Curio program.

import type { Environment } from "./environment.js";
import { NativeFunction, stringify, type NativeContext, type Value } from "./values.js";

function def(
  env: Environment,
  name: string,
  minArgs: number,
  maxArgs: number,
  fn: (args: Value[], ctx: NativeContext) => Value,
): void {
  env.define(name, new NativeFunction(name, minArgs, maxArgs, fn));
}

export function installStdlib(env: Environment): void {
  def(env, "print", 0, Infinity, (args, ctx) => {
    ctx.out(args.map((a) => stringify(a)).join(" ") + "\n");
    return null;
  });
}
