import { describe, expect, it } from "vitest";
import { REPL_HELP, ReplSession } from "../src/repl.js";

/** Feed lines to a session; returns what it wrote and the status after each line. */
function session() {
  let output = "";
  const s = new ReplSession((t) => (output += t));
  return {
    s,
    send(...lines: string[]) {
      return lines.map((l) => s.feed(l));
    },
    /** Output produced since the last call. */
    take() {
      const o = output;
      output = "";
      return o;
    },
  };
}

describe("repl: state and echo", () => {
  it("keeps variables between lines and echoes expression results", () => {
    const r = session();
    r.send("let x = 40;");
    expect(r.take()).toBe("");
    r.send("x + 2");
    expect(r.take()).toBe("42\n");
    r.send("x = x + 1;"); // an assignment is an expression, so it echoes like in a JavaScript REPL
    expect(r.take()).toBe("41\n");
    r.send("x");
    expect(r.take()).toBe("41\n");
  });

  it("echoes values the way a program would write them in code", () => {
    const r = session();
    r.send('"hi"');
    r.send("[1, \"a\", nil]");
    r.send("{a: 1}");
    r.send("1 == 1");
    expect(r.take()).toBe('"hi"\n[1, "a", nil]\n{"a": 1}\ntrue\n');
  });

  it("does not echo nil, declarations or statements", () => {
    const r = session();
    r.send("let a = 1;", "nil", "if true { 5; }", "while false { }", 'print("shown");');
    expect(r.take()).toBe("shown\n");
  });

  it("ignores blank lines", () => {
    const r = session();
    expect(r.send("", "   ")).toEqual(["done", "done"]);
    expect(r.take()).toBe("");
  });
});

describe("repl: closures across lines", () => {
  it("defines a counter factory and keeps calling it", () => {
    const r = session();
    r.send("let makeCounter = fn() {", "  let count = 0;", "  return fn() { count = count + 1; return count; };", "};");
    expect(r.take()).toBe("");
    r.send("let next = makeCounter();");
    r.send("next()", "next()", "next()");
    expect(r.take()).toBe("1\n2\n3\n");
    r.send("let other = makeCounter();", "other()", "next()");
    expect(r.take()).toBe("1\n4\n");
  });
});

describe("repl: multi-line input", () => {
  it("asks for more until the statement is complete", () => {
    const r = session();
    expect(r.send("fn add(a, b) {", "  return a + b;", "}")).toEqual(["more", "more", "done"]);
    expect(r.s.isContinuing).toBe(false);
    r.send("add(2, 3)");
    expect(r.take()).toBe("5\n");
  });

  it("continues after an operator, an open paren or array, and an open comment", () => {
    const r = session();
    expect(r.send("1 +", "2")).toEqual(["more", "done"]);
    expect(r.send("print(", "1,", "2)")).toEqual(["more", "more", "done"]);
    expect(r.send("[1,", "2]")).toEqual(["more", "done"]);
    expect(r.send("/* start", "end */ 7")).toEqual(["more", "done"]);
    expect(r.take()).toBe("3\n1 2\n[1, 2]\n7\n");
  });

  it("reports a real error right away instead of waiting for more", () => {
    const r = session();
    expect(r.send("let = 1;")).toEqual(["done"]);
    expect(r.take()).toContain("error: Expected variable name after 'let', found '='");
    expect(r.send('let s = "oops')).toEqual(["done"]);
    expect(r.take()).toContain("Unterminated string");
  });

  it("can abandon half-typed input", () => {
    const r = session();
    r.send("if true {");
    expect(r.s.isContinuing).toBe(true);
    r.s.cancel();
    expect(r.s.isContinuing).toBe(false);
    r.send("1 + 1");
    expect(r.take()).toBe("2\n");
  });
});

describe("repl: errors do not end the session", () => {
  it("shows syntax errors with a caret and keeps going", () => {
    const r = session();
    r.send("let a = 1;");
    r.send("let b = ;");
    const text = r.take();
    expect(text).toContain("error: Expected expression, found ';'");
    expect(text).toContain("<repl>:2:9");
    expect(text).toContain("2 | let b = ;");
    r.send("a");
    expect(r.take()).toBe("1\n");
  });

  it("shows runtime errors with a stack trace and keeps state", () => {
    const r = session();
    r.send("let keep = 7;", "fn boom() { return missing; }");
    r.send("boom()");
    const text = r.take();
    expect(text).toContain("runtime error: Undefined variable 'missing'");
    expect(text).toContain("at boom (<repl>:2)");
    expect(text).toContain("at <main> (<repl>:3)");
    // the source line of a function defined on an earlier line is still shown
    expect(text).toContain("2 | fn boom() { return missing; }");
    r.send("keep");
    expect(r.take()).toBe("7\n");
  });
});

describe("repl: commands", () => {
  it("prints help", () => {
    const r = session();
    expect(r.send(".help")).toEqual(["done"]);
    expect(r.take()).toBe(REPL_HELP + "\n");
  });

  it("exits", () => {
    expect(session().send(".exit")).toEqual(["exit"]);
    expect(session().send(".quit")).toEqual(["exit"]);
  });

  it("resets state", () => {
    const r = session();
    r.send("let x = 1;", ".reset");
    expect(r.take()).toBe("State cleared.\n");
    r.send("x");
    expect(r.take()).toContain("Undefined variable 'x'");
  });

  it("rejects unknown commands", () => {
    const r = session();
    r.send(".nope");
    expect(r.take()).toBe("Unknown command '.nope'. Type .help for the list.\n");
  });

  it("treats a dot inside a multi-line statement as ordinary input", () => {
    const r = session();
    expect(r.send("print(1,", ".5)")).toEqual(["more", "done"]);
    expect(r.take()).toContain("Unexpected character '.'");
  });
});
