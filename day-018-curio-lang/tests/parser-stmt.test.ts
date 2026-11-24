import { describe, expect, it } from "vitest";
import { dumpAst } from "../src/ast.js";
import { CurioSyntaxError } from "../src/errors.js";
import { parse, parseOrThrow } from "../src/parser.js";

const dump = (src: string): string => {
  const r = parse(src);
  expect(r.errors, `unexpected errors for ${src}`).toEqual([]);
  return dumpAst(r.program);
};
const lines = (...l: string[]) => l.join("\n");
const messages = (src: string) => parse(src).errors.map((e) => `${e.line}:${e.col} ${e.message}`);

describe("parser: AST snapshots for each statement type", () => {
  it("empty program", () => {
    expect(dump("")).toBe("Program");
    expect(dump("  // nothing here\n")).toBe("Program");
  });

  it("let with and without initializer", () => {
    expect(dump("let x = 1 + 2;")).toBe(lines("Program", "  Let x", "    Binary +", "      Number 1", "      Number 2"));
    expect(dump("let y;")).toBe(lines("Program", "  Let y"));
  });

  it("expression statement", () => {
    expect(dump("f(1);")).toBe(lines("Program", "  ExprStmt", "    Call", "      callee: Ident f", "      arg: Number 1"));
  });

  it("block statement", () => {
    expect(dump("{ let a = 1; a; }")).toBe(
      lines("Program", "  Block", "    Let a", "      Number 1", "    ExprStmt", "      Ident a"),
    );
  });

  it("if / else if / else", () => {
    expect(dump("if a { 1; } else if b { 2; } else { 3; }")).toBe(
      lines(
        "Program",
        "  If",
        "    cond: Ident a",
        "    then: Block",
        "      ExprStmt",
        "        Number 1",
        "    else: If",
        "      cond: Ident b",
        "      then: Block",
        "        ExprStmt",
        "          Number 2",
        "      else: Block",
        "        ExprStmt",
        "          Number 3",
      ),
    );
  });

  it("if without else, with optional parentheses around the condition", () => {
    expect(dump("if (a) { }")).toBe(lines("Program", "  If", "    cond: Ident a", "    then: Block"));
    expect(dump("if a == 1 {}")).toBe(
      lines("Program", "  If", "    cond: Binary ==", "      Ident a", "      Number 1", "    then: Block"),
    );
  });

  it("while", () => {
    expect(dump("while x < 3 { x = x + 1; }")).toBe(
      lines(
        "Program",
        "  While",
        "    cond: Binary <",
        "      Ident x",
        "      Number 3",
        "    body: Block",
        "      ExprStmt",
        "        Assign",
        "          target: Ident x",
        "          value: Binary +",
        "            Ident x",
        "            Number 1",
      ),
    );
  });

  it("for-in", () => {
    expect(dump("for i in xs { print(i); }")).toBe(
      lines(
        "Program",
        "  For i",
        "    in: Ident xs",
        "    body: Block",
        "      ExprStmt",
        "        Call",
        "          callee: Ident print",
        "          arg: Ident i",
      ),
    );
  });

  it("break and continue inside a loop", () => {
    expect(dump("while true { if a { break; } continue; }")).toBe(
      lines(
        "Program",
        "  While",
        "    cond: Bool true",
        "    body: Block",
        "      If",
        "        cond: Ident a",
        "        then: Block",
        "          Break",
        "      Continue",
      ),
    );
  });

  it("assignment to an index and logical operators", () => {
    expect(dump("a[0] = b or c;")).toBe(
      lines(
        "Program",
        "  ExprStmt",
        "    Assign",
        "      target: Index",
        "        object: Ident a",
        "        index: Number 0",
        "      value: Logical or",
        "        Ident b",
        "        Ident c",
      ),
    );
  });

  it("covers the remaining literal and unary node labels", () => {
    expect(dump('!nil; -"s"; false;')).toBe(
      lines(
        "Program",
        "  ExprStmt",
        "    Unary !",
        "      Nil",
        "  ExprStmt",
        "    Unary -",
        '      String "s"',
        "  ExprStmt",
        "    Bool false",
      ),
    );
  });
});

describe("parser: statement rules", () => {
  it("makes the semicolon optional before } and at end of input only", () => {
    expect(dump("{ 1 }")).toContain("Number 1");
    expect(dump("1")).toContain("Number 1");
    expect(dump("let a = 1")).toContain("Let a");
    expect(messages("1 2")).toEqual(["1:3 Expected ';' after expression, found number 2"]);
  });

  it("records source positions on statements", () => {
    const { program } = parse("let a = 1;\n  while a { }");
    expect(program.body[0]!.pos).toEqual({ line: 1, col: 1 });
    expect(program.body[1]!.pos).toEqual({ line: 2, col: 3 });
    expect(program.pos).toEqual({ line: 1, col: 1 });
  });

  it("allows nested blocks and loops", () => {
    expect(() => parseOrThrow("for a in b { for c in d { while e { break; } } }")).not.toThrow();
  });

  it("rejects break/continue outside loops and return outside functions", () => {
    expect(messages("break;")).toEqual(["1:1 'break' outside of a loop"]);
    expect(messages("continue;")).toEqual(["1:1 'continue' outside of a loop"]);
    expect(messages("if true { break; }")).toEqual(["1:11 'break' outside of a loop"]);
    expect(messages("return 1;")).toEqual(["1:1 'return' outside of a function"]);
    expect(messages("return;")).toEqual(["1:1 'return' outside of a function"]);
  });

  it("explains malformed statements", () => {
    expect(messages("let = 1;")).toEqual(["1:5 Expected variable name after 'let', found '='"]);
    expect(messages("if x 1;")).toEqual(["1:6 Expected '{' after if condition, found number 1"]);
    expect(messages("if x { } else 1;")).toEqual(["1:15 Expected '{' or 'if' after 'else', found number 1"]);
    expect(messages("while x 1;")).toEqual(["1:9 Expected '{' after while condition, found number 1"]);
    expect(messages("for 1 in x { }")).toEqual(["1:5 Expected loop variable name after 'for', found number 1"]);
    expect(messages("for 1 in x { } let ok = 1;")).toHaveLength(1);
    expect(messages("for a x { }")).toEqual(["1:7 Expected 'in' after loop variable, found identifier 'x'"]);
    expect(messages("for a in x 1;")).toEqual(["1:12 Expected '{' after for iterable, found number 1"]);
    expect(messages("let a = 1 let b = 2;")).toEqual(["1:11 Expected ';' after variable declaration, found 'let'"]);
  });

  it("reports an unclosed block at end of input", () => {
    const r = parse("if x { 1;");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ message: "Expected '}' to close the block, found end of input", atEof: true });
  });

  it("reports a stray closing brace and continues", () => {
    expect(messages("let a = 1; } let b = 2;")).toEqual(["1:12 Unexpected '}' with no matching '{'"]);
    const r = parse("} let b = 2;");
    expect(r.program.body).toHaveLength(1);
  });
});

describe("parser: error recovery", () => {
  it("reports several syntax errors from one run", () => {
    const src = ["let a = ;", "let b = 2;", "let c = (1 + ;", "print(b);", "let d = 3 +;"].join("\n");
    expect(messages(src)).toEqual([
      "1:9 Expected expression, found ';'",
      "3:14 Expected expression, found ';'",
      "5:12 Expected expression, found ';'",
    ]);
  });

  it("keeps the statements that were fine", () => {
    const r = parse("let a = ;\nlet b = 2;\nlet c = ;\nlet d = 4;");
    expect(r.errors).toHaveLength(2);
    expect(r.program.body.map((s) => (s.kind === "Let" ? s.name : "?"))).toEqual(["b", "d"]);
  });

  it("recovers inside blocks without losing the surrounding structure", () => {
    const src = "fnless { let a = ; let b = 1; } let after = 2;";
    const r = parse(src);
    expect(r.errors.map((e) => e.message)).toContain("Expected ';' after expression, found '{'");
    const names = JSON.stringify(r.program);
    expect(names).toContain('"name":"after"');

    const r2 = parse("while true { let a = ; let b = 1; break; }\nlet after = 2;");
    expect(r2.errors).toHaveLength(1);
    const loop = r2.program.body[0]!;
    expect(loop.kind).toBe("While");
    if (loop.kind === "While") expect(loop.body.body.map((s) => s.kind)).toEqual(["Let", "Break"]);
    expect(r2.program.body.map((s) => s.kind)).toEqual(["While", "Let"]);
  });

  it("resumes at the next statement keyword when a semicolon is missing", () => {
    const r = parse("let a = 1 let b = 2; if x { } while y { }");
    expect(r.errors).toHaveLength(1);
    expect(r.program.body.map((s) => s.kind)).toEqual(["Let", "If", "While"]);
  });

  it("always makes progress on garbage input", () => {
    const r = parse(") ] ) else else");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(() => parse("{ { { ")).not.toThrow();
    expect(() => parse("=== !!! ,,, :::")).not.toThrow();
  });

  it("merges lexer errors with parser errors in source order, once per position", () => {
    const r = parse('let a = 1 @ 2;\nlet b = "oops;\nlet c = ;');
    // The lexer errors are reported once each; the parser does not pile a second error on top.
    expect(r.errors.map((e) => `${e.line}:${e.col} ${e.message}`)).toEqual([
      "1:11 Unexpected character '@'",
      "2:9 Unterminated string",
      "3:9 Expected expression, found ';'",
    ]);
    expect(r.program.body.map((s) => s.kind)).toEqual([]);
  });

  it("parseOrThrow returns the program or throws a CurioSyntaxError with every diagnostic", () => {
    expect(parseOrThrow("let a = 1;").body).toHaveLength(1);
    try {
      parseOrThrow("let a = ;\nlet b = ;");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CurioSyntaxError);
      expect((e as CurioSyntaxError).diagnostics).toHaveLength(2);
      const text = (e as CurioSyntaxError).format("let a = ;\nlet b = ;", "demo.curio");
      expect(text).toContain("demo.curio:1:9");
      expect(text).toContain("demo.curio:2:9");
      expect(text).toContain("2 syntax errors found.");
    }
  });
});
