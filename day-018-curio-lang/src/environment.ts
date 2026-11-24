// Lexical environments: a chain of scopes, innermost first.

import type { Value } from "./values.js";

export class Environment {
  private readonly vars = new Map<string, Value>();

  constructor(readonly parent: Environment | null = null) {}

  /** Create (or overwrite) a variable in this scope. */
  define(name: string, value: Value): void {
    this.vars.set(name, value);
  }

  /** Find a variable in this scope or an enclosing one. Undefined means "no such variable". */
  get(name: string): Value | undefined {
    for (let env: Environment | null = this; env !== null; env = env.parent) {
      const v = env.vars.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /** Update the nearest existing variable. Returns false if there is none. */
  assign(name: string, value: Value): boolean {
    for (let env: Environment | null = this; env !== null; env = env.parent) {
      if (env.vars.has(name)) {
        env.vars.set(name, value);
        return true;
      }
    }
    return false;
  }

  /** Names defined directly in this scope (used by tests and the REPL). */
  names(): string[] {
    return [...this.vars.keys()];
  }
}
