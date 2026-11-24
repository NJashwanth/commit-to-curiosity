import { describe, expect, it } from "vitest";
import { lex } from "../src/lexer.js";
import { T, describeToken, type Token } from "../src/token.js";
import { CurioSyntaxError, formatDiagnostic, formatDiagnostics } from "../src/errors.js";

const types = (src: string) => lex(src).tokens.map((t) => t.type);
const first = (src: string): Token => lex(src).tokens[0]!;

describe("lexer: token types", () => {
  it("produces only EOF for empty and whitespace-only input", () => {
    expect(types("")).toEqual([T.EOF]);
    expect(types("  \n\t \r\n ")).toEqual([T.EOF]);
  });

  it.each([
    ["let", T.Let],
    ["fn", T.Fn],
    ["return", T.Return],
    ["if", T.If],
    ["else", T.Else],
    ["while", T.While],
    ["for", T.For],
    ["in", T.In],
    ["true", T.True],
    ["false", T.False],
    ["nil", T.Nil],
    ["and", T.And],
    ["or", T.Or],
    ["break", T.Break],
    ["continue", T.Continue],
  ])("keyword %s", (word, type) => {
    expect(types(word)).toEqual([type, T.EOF]);
  });

  it("treats keyword prefixes and near misses as identifiers", () => {
    expect(types("letter fnord iff _x x1 If")).toEqual([T.Ident, T.Ident, T.Ident, T.Ident, T.Ident, T.Ident, T.EOF]);
  });

  it.each([
    ["+", T.Plus],
    ["-", T.Minus],
    ["*", T.Star],
    ["/", T.Slash],
    ["%", T.Percent],
    ["!", T.Bang],
    ["!=", T.BangEq],
    ["=", T.Eq],
    ["==", T.EqEq],
    ["<", T.Lt],
    ["<=", T.Le],
    [">", T.Gt],
    [">=", T.Ge],
    ["(", T.LParen],
    [")", T.RParen],
    ["{", T.LBrace],
    ["}", T.RBrace],
    ["[", T.LBracket],
    ["]", T.RBracket],
    [",", T.Comma],
    [";", T.Semicolon],
    [":", T.Colon],
  ])("operator or punctuation %s", (text, type) => {
    expect(types(text)).toEqual([type, T.EOF]);
  });

  it("prefers two-character operators and splits correctly", () => {
    expect(types("a<=b>=c==d!=e")).toEqual([
      T.Ident, T.Le, T.Ident, T.Ge, T.Ident, T.EqEq, T.Ident, T.BangEq, T.Ident, T.EOF,
    ]);
    expect(types("!!x")).toEqual([T.Bang, T.Bang, T.Ident, T.EOF]);
    expect(types("a=!b")).toEqual([T.Ident, T.Eq, T.Bang, T.Ident, T.EOF]);
  });

  it("lexes a realistic statement", () => {
    expect(types("let x = fn(a, b) { a + b; };")).toEqual([
      T.Let, T.Ident, T.Eq, T.Fn, T.LParen, T.Ident, T.Comma, T.Ident, T.RParen,
      T.LBrace, T.Ident, T.Plus, T.Ident, T.Semicolon, T.RBrace, T.Semicolon, T.EOF,
    ]);
  });
});

describe("lexer: numbers", () => {
  it.each([
    ["0", 0],
    ["42", 42],
    ["3.14", 3.14],
    ["0.5", 0.5],
    ["1e3", 1000],
    ["2.5E-2", 0.025],
    ["1e+2", 100],
  ])("%s", (text, value) => {
    const t = first(text);
    expect(t.type).toBe(T.Number);
    expect(t.value).toBe(value);
    expect(t.lexeme).toBe(text);
  });

  it("does not treat a trailing dot or a bare exponent letter as part of the number", () => {
    const r = lex("1.");
    expect(r.tokens[0]!.value).toBe(1);
    expect(r.errors[0]!.message).toBe("Unexpected character '.'");
    // "1e" is a number followed by an identifier-ish suffix, so it is one invalid literal
    expect(lex("1e").errors[0]!.message).toBe("Invalid number '1e'");
  });

  it("reports malformed numbers once", () => {
    const r = lex("12abc + 1");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ message: "Invalid number '12abc'", line: 1, col: 1, length: 5 });
    expect(r.tokens.map((t) => t.type)).toEqual([T.Error, T.Plus, T.Number, T.EOF]);
  });
});

describe("lexer: strings", () => {
  it("decodes plain strings with either quote", () => {
    expect(first('"hello"')).toMatchObject({ type: T.String, value: "hello", lexeme: '"hello"' });
    expect(first("'hi'")).toMatchObject({ type: T.String, value: "hi" });
    expect(first('""').value).toBe("");
  });

  it.each([
    ['"a\\nb"', "a\nb"],
    ['"a\\tb"', "a\tb"],
    ['"a\\rb"', "a\rb"],
    ['"a\\0b"', "a\0b"],
    ['"back\\\\slash"', "back\\slash"],
    ['"say \\"hi\\""', 'say "hi"'],
    ["'it\\'s'", "it's"],
    ['"cost \\$5"', "cost $5"],
  ])("escape in %s", (src, value) => {
    const r = lex(src);
    expect(r.errors).toEqual([]);
    expect(r.tokens[0]!.value).toBe(value);
  });

  it("reports unknown escapes at the backslash and keeps going", () => {
    const r = lex('"a\\qb" 1');
    expect(r.errors).toEqual([{ message: "Unknown escape sequence '\\q'", line: 1, col: 3, length: 2 }]);
    expect(r.tokens.map((t) => t.type)).toEqual([T.String, T.Number, T.EOF]);
    expect(r.tokens[0]!.value).toBe("ab");
  });

  it("reports an unterminated string at its opening quote (end of input)", () => {
    const r = lex('let s = "oops');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ message: "Unterminated string", line: 1, col: 9, atEof: true });
    expect(r.tokens.map((t) => t.type)).toEqual([T.Let, T.Ident, T.Eq, T.Error, T.EOF]);
  });

  it("ends an unterminated string at the newline and lexes the next line normally", () => {
    const r = lex('"oops\nlet x = 1;');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ message: "Unterminated string", line: 1, col: 1 });
    expect(r.errors[0]!.atEof).toBeUndefined();
    expect(r.tokens[0]).toMatchObject({ type: T.Error, lexeme: '"oops' });
    expect(r.tokens[1]).toMatchObject({ type: T.Let, line: 2, col: 1 });
  });

  it("treats a trailing backslash as an unterminated string", () => {
    expect(lex('"abc\\').errors[0]!.message).toBe("Unterminated string");
    expect(lex('"abc\\\nx').errors[0]!.message).toBe("Unterminated string");
  });
});

describe("lexer: interpolation", () => {
  const parts = (src: string) => first(src).parts!;

  it("splits a template into text and expression tokens", () => {
    const t = first('"a ${x + 1} b"');
    expect(t.type).toBe(T.Template);
    expect(t.parts).toHaveLength(3);
    expect(t.parts![0]).toBe("a ");
    const expr = t.parts![1] as Token[];
    expect(expr.map((x) => x.type)).toEqual([T.Ident, T.Plus, T.Number, T.EOF]);
    expect(t.parts![2]).toBe(" b");
  });

  it("keeps real positions on tokens inside the interpolation", () => {
    const expr = parts('"hi ${name}"')[1] as Token[];
    expect(expr[0]).toMatchObject({ lexeme: "name", line: 1, col: 7 });
  });

  it("handles adjacent interpolations and no surrounding text", () => {
    const p = parts('"${a}${b}"');
    expect(p).toHaveLength(2);
    expect(Array.isArray(p[0]) && Array.isArray(p[1])).toBe(true);
  });

  it("handles braces and nested strings inside an interpolation", () => {
    const r = lex('"v: ${ {"k": 1}["k"] } and ${"in ${x}ner"}"');
    expect(r.errors).toEqual([]);
    expect(r.tokens[0]!.type).toBe(T.Template);
    const nested = (r.tokens[0]!.parts![3] as Token[])[0]!;
    expect(nested.type).toBe(T.Template);
  });

  it("allows an escaped dollar to stay literal", () => {
    expect(first('"\\${x}"')).toMatchObject({ type: T.String, value: "${x}" });
    expect(first('"cost $5"')).toMatchObject({ type: T.String, value: "cost $5" });
  });

  it("reports an unterminated interpolation", () => {
    const r = lex('"a ${x + 1');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      message: "Unterminated string interpolation, expected '}'",
      line: 1,
      col: 4,
      atEof: true,
    });
    expect(r.tokens.map((t) => t.type)).toEqual([T.Error, T.EOF]);
  });
});

describe("lexer: comments, whitespace and positions", () => {
  it("skips line and block comments", () => {
    expect(types("1 // comment\n2 /* block\n over lines */ 3")).toEqual([T.Number, T.Number, T.Number, T.EOF]);
    expect(types("// only a comment")).toEqual([T.EOF]);
    expect(types("a / b")).toEqual([T.Ident, T.Slash, T.Ident, T.EOF]);
  });

  it("reports an unterminated block comment", () => {
    const r = lex("1 /* never ends");
    expect(r.errors).toEqual([{ message: "Unterminated block comment", line: 1, col: 3, length: 2, atEof: true }]);
  });

  it("tracks line and column across lines", () => {
    const toks = lex("let a = 1;\n  let b\t= 2;").tokens;
    expect(toks.map((t) => [t.lexeme, t.line, t.col])).toEqual([
      ["let", 1, 1], ["a", 1, 5], ["=", 1, 7], ["1", 1, 9], [";", 1, 10],
      ["let", 2, 3], ["b", 2, 7], ["=", 2, 9], ["2", 2, 11], [";", 2, 12],
      ["", 2, 13],
    ]);
  });

  it("tracks positions after a multi-line block comment", () => {
    const t = lex("/* a\nb */ x").tokens[0]!;
    expect([t.line, t.col]).toEqual([2, 6]);
  });
});

describe("lexer: unknown characters", () => {
  it("reports each unknown character with its position and keeps lexing", () => {
    const r = lex("let a = 1 @ 2;\n  b = #;");
    expect(r.errors.map((e) => [e.message, e.line, e.col])).toEqual([
      ["Unexpected character '@'", 1, 11],
      ["Unexpected character '#'", 2, 7],
    ]);
    expect(r.tokens.filter((t) => t.type === T.Number)).toHaveLength(2);
    expect(r.tokens.filter((t) => t.type === T.Error).map((t) => t.lexeme)).toEqual(["@", "#"]);
  });

  it("handles astral characters as a single unit", () => {
    const r = lex("😀 1");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ message: "Unexpected character '😀'", col: 1, length: 2 });
    expect(r.tokens.map((t) => t.type)).toEqual([T.Error, T.Number, T.EOF]);
    expect(r.tokens[1]).toMatchObject({ col: 4 });
  });
});

describe("token helpers and diagnostics formatting", () => {
  it("describes tokens for error messages", () => {
    const d = (s: string) => describeToken(first(s));
    expect(d("")).toBe("end of input");
    expect(d("foo")).toBe("identifier 'foo'");
    expect(d("42")).toBe("number 42");
    expect(d('"x"')).toBe("a string");
    expect(d('"${x}"')).toBe("a string");
    expect(d(")")).toBe("')'");
    expect(d("while")).toBe("'while'");
  });

  it("formats a diagnostic with a caret under the token", () => {
    const src = "let a = 1;\nlet b = ;";
    expect(formatDiagnostic(src, { message: "Expected expression", line: 2, col: 9 }, "t.curio")).toBe(
      ["error: Expected expression", "  --> t.curio:2:9", "  |", "2 | let b = ;", "  |         ^"].join("\n"),
    );
  });

  it("underlines the whole token and clamps to the line", () => {
    const out = formatDiagnostic("12abc", { message: "bad", line: 1, col: 1, length: 5 });
    expect(out.split("\n")[4]).toBe("  | ^~~~~");
    const clamped = formatDiagnostic("ab", { message: "bad", line: 1, col: 2, length: 9 });
    expect(clamped.split("\n")[4]).toBe("  |  ^");
  });

  it("copies tabs so the caret lines up, and survives a missing line", () => {
    const out = formatDiagnostic("\tx = ;", { message: "bad", line: 1, col: 6 });
    expect(out.split("\n")[4]).toBe("  | \t    ^");
    expect(formatDiagnostic("", { message: "bad", line: 5, col: 1 }, undefined, "warning")).toContain("warning: bad");
  });

  it("pads the gutter for multi-digit line numbers", () => {
    const src = "\n".repeat(11) + "oops";
    const out = formatDiagnostic(src, { message: "bad", line: 12, col: 1 });
    expect(out.split("\n").slice(1)).toEqual(["   --> <input>:12:1", "   |", "12 | oops", "   | ^"]);
  });

  it("formats several diagnostics with a count, and CurioSyntaxError carries them", () => {
    const ds = [
      { message: "one", line: 1, col: 1, length: 1 },
      { message: "two", line: 1, col: 3, length: 1 },
    ];
    const text = formatDiagnostics("a b c", ds, "f.curio");
    expect(text).toContain("error: one");
    expect(text).toContain("error: two");
    expect(text.endsWith("2 syntax errors found.")).toBe(true);
    expect(formatDiagnostics("a", [ds[0]!]).endsWith("1 syntax error found.")).toBe(true);

    const err = new CurioSyntaxError(ds);
    expect(err.name).toBe("CurioSyntaxError");
    expect(err.message).toBe("1:1: one\n1:3: two");
    expect(err.format("a b c")).toContain("2 syntax errors found.");
  });
});
