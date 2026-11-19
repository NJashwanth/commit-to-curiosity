import { describe, expect, it } from "vitest";
import { AutogradError, Value } from "../src/engine";
import {
  BOX,
  MAX_EXPRESSION_LENGTH,
  MAX_GRAPH_NODES,
  ParseError,
  build,
  escapeXml,
  format,
  formatNumber,
  layout,
  opSymbol,
  parse,
  renderSvg,
  run,
  variables,
  type Expr,
} from "../src/graphview";

/** Fully parenthesised form, to check how the parser grouped things. */
function sexpr(e: Expr): string {
  switch (e.kind) {
    case "num":
      return String(e.value);
    case "var":
      return e.name;
    case "neg":
      return `(neg ${sexpr(e.arg)})`;
    case "call":
      return `(${e.fn} ${sexpr(e.arg)})`;
    case "bin":
      return `(${e.op} ${sexpr(e.left)} ${sexpr(e.right)})`;
  }
}

const tree = (src: string) => sexpr(parse(src));

describe("parser precedence and associativity", () => {
  it.each([
    ["a + b * c", "(+ a (* b c))"],
    ["a * b + c", "(+ (* a b) c)"],
    ["a - b - c", "(- (- a b) c)"],
    ["a / b / c", "(/ (/ a b) c)"],
    ["a * b / c * d", "(* (/ (* a b) c) d)"],
    ["a ^ b ^ c", "(^ a (^ b c))"],
    ["a * b ^ 2", "(* a (^ b 2))"],
    ["-a ^ 2", "(neg (^ a 2))"],
    ["a ^ -2", "(^ a -2)"],
    ["a ^ -b", "(^ a (neg b))"],
    ["-a * b", "(* (neg a) b)"],
    ["--a", "(neg (neg a))"],
    ["a - -b", "(- a (neg b))"],
    ["a ** 2", "(^ a 2)"],
    ["2 * -3", "(* 2 -3)"],
  ])("%s", (src, expected) => {
    expect(tree(src)).toBe(expected);
  });
});

describe("parser parentheses, functions, numbers", () => {
  it.each([
    ["(a + b) * c", "(* (+ a b) c)"],
    ["a * (b + c)", "(* a (+ b c))"],
    ["((a))", "a"],
    ["(a - (b - c))", "(- a (- b c))"],
    ["tanh(a*b + c)", "(tanh (+ (* a b) c))"],
    ["exp(log(x))", "(exp (log x))"],
    ["relu(x) + sigmoid(-x)", "(+ (relu x) (sigmoid (neg x)))"],
    ["tanh(x)^2", "(^ (tanh x) 2)"],
    ["  w1*x1+w2*x2 ", "(+ (* w1 x1) (* w2 x2))"],
    ["1.5 + .5 + 2. + 1e-3 + 2E2", "(+ (+ (+ (+ 1.5 0.5) 2) 0.001) 200)"],
    ["_tmp9", "_tmp9"],
  ])("%s", (src, expected) => {
    expect(tree(src)).toBe(expected);
  });
});

describe("parser rejects invalid input", () => {
  it.each([
    ["", "Expected a number, variable, function or '(' at position 1, but found the end of the expression"],
    ["a +", /but found the end of the expression/],
    ["* a", "Expected a number, variable, function or '(' at position 1, but found '*'"],
    ["(a + b", "Expected ')' to close the '(' at position 1, but found the end of the expression"],
    ["tanh(a", "Expected ')' to close the '(' at position 5, but found the end of the expression"],
    ["a + b)", "Unexpected ')' at position 6"],
    ["a b", "Unexpected 'b' at position 3"],
    ["2a", "Unexpected 'a' at position 2"],
    ["foo(a)", "Unknown function 'foo'; available: exp, log, tanh, relu, sigmoid"],
    ["tanh + 1", "'tanh' is a function; write tanh(...)"],
    ["a $ b", "Unexpected character '$' at position 3"],
    ["a ^", /found the end/],
    ["()", "Expected a number, variable, function or '(' at position 2, but found ')'"],
    ["1e999", "Number 1e999 is too large"],
    ["+a", /found '\+'/],
  ])("%j", (src, message) => {
    expect(() => parse(src)).toThrow(ParseError);
    expect(() => parse(src)).toThrow(message);
  });

  it("reports the position of the problem", () => {
    try {
      parse("a + (b * c");
      expect.unreachable();
    } catch (e) {
      expect((e as ParseError).position).toBe(10);
      expect((e as ParseError).name).toBe("ParseError");
    }
  });

  it("limits the expression length", () => {
    expect(() => parse("a+".repeat(MAX_EXPRESSION_LENGTH) + "a")).toThrow(/too long/);
  });
});

describe("variables and format", () => {
  it("lists variables in order of first use, once each", () => {
    expect(variables(parse("tanh(a*b + c) + a*2 - exp(-b)"))).toEqual(["a", "b", "c"]);
    expect(variables(parse("3 * 4"))).toEqual([]);
  });

  it.each([
    "a*b + c",
    "tanh(a*b + c)",
    "a - (b - c)",
    "a - (b + c)",
    "a/(b/c)",
    "a/(b*c)",
    "(a + b)*c",
    "a^b^c",
    "(a^b)^c",
    "-a^2",
    "(-a)^2",
    "(-2)^2",
    "a^-b",
    "-(a + b)",
    "--a",
    "a*-2",
    "2*-a",
    "exp(-a)*log(b + 1)",
  ])("round-trips %s", (src) => {
    const formatted = format(parse(src));
    expect(formatted).toBe(src);
    expect(sexpr(parse(formatted))).toBe(sexpr(parse(src)));
  });

  it("drops redundant parentheses", () => {
    expect(format(parse("((a*b)) + (c)"))).toBe("a*b + c");
    expect(format(parse("(a - b) - c"))).toBe("a - b - c");
  });
});

describe("build and run", () => {
  it("tanh(a*b + c) gives the hand-computed data and grads", () => {
    const { output, inputs } = run("tanh(a*b + c)", { a: 2, b: -0.5, c: 0.25 });
    const local = 1 - Math.tanh(-0.75) ** 2; // 0.5966
    expect(output.data).toBeCloseTo(Math.tanh(-0.75), 12);
    expect(output.label).toBe("tanh(a*b + c)");
    expect(inputs.get("a")!.grad).toBeCloseTo(-0.5 * local, 12);
    expect(inputs.get("b")!.grad).toBeCloseTo(2 * local, 12);
    expect(inputs.get("c")!.grad).toBeCloseTo(local, 12);
    const labels = output.topo().map((v) => v.label);
    expect(labels).toEqual(["a", "b", "a*b", "c", "a*b + c", "tanh(a*b + c)"]);
  });

  it("a variable used twice is one node that accumulates", () => {
    const { output, inputs } = run("a*a + a", { a: 3 });
    expect(output.data).toBe(12);
    expect(inputs.get("a")!.grad).toBe(7);
    expect(output.topo().filter((v) => v.label === "a")).toHaveLength(1);
  });

  it("supports every operator and function", () => {
    const vals = { a: 1.5, b: 0.5 };
    const { output, inputs } = run("exp(a) - log(b) / sigmoid(a) * relu(a - b) + tanh(b)^2 + a^b + -b", vals);
    const expected =
      Math.exp(1.5) - (Math.log(0.5) / (1 / (1 + Math.exp(-1.5)))) * 1 + Math.tanh(0.5) ** 2 + 1.5 ** 0.5 - 0.5;
    expect(output.data).toBeCloseTo(expected, 12);
    // Check one grad numerically.
    const h = 1e-6;
    const at = (a: number) => build(parse("exp(a) - log(b) / sigmoid(a) * relu(a - b) + tanh(b)^2 + a^b + -b"), { ...vals, a }).output.data;
    expect(inputs.get("a")!.grad).toBeCloseTo((at(1.5 + h) - at(1.5 - h)) / (2 * h), 6);
  });

  it("a constant exponent stays a number, a variable exponent becomes a node", () => {
    const constant = build(parse("a^2"), { a: 3 }).output;
    expect(constant.parents).toHaveLength(1);
    expect(constant.exponent).toBe(2);
    const variable = build(parse("a^b"), { a: 3, b: 2 }).output;
    expect(variable.parents).toHaveLength(2);
  });

  it("a lone variable or number is its own output", () => {
    expect(run("x", { x: 4 }).output.grad).toBe(1);
    expect(run("-2.5", {}).output.data).toBe(-2.5);
  });

  it("reports missing variables and engine errors", () => {
    expect(() => run("a + b", { a: 1 })).toThrow("No value for variable 'b'");
    expect(() => run("a + b", { a: 1, b: NaN })).toThrow(AutogradError);
    expect(() => run("1 / (a - a)", { a: 2 })).toThrow(/Division by zero/);
    expect(() => run("log(a - 3)", { a: 2 })).toThrow(/log\(-1\)/);
  });
});

describe("layout", () => {
  it("places inputs left of the nodes they feed and the output last", () => {
    const { output } = run("tanh(a*b + c)", { a: 2, b: -0.5, c: 0.25 });
    const g = layout(output);
    const byLabel = new Map(g.nodes.map((n) => [n.value.label, n]));
    expect(byLabel.get("a")!.column).toBe(0);
    expect(byLabel.get("b")!.column).toBe(0);
    expect(byLabel.get("a*b")!.column).toBe(1);
    // c sits just left of its consumer instead of back in column 0.
    expect(byLabel.get("c")!.column).toBe(1);
    expect(byLabel.get("a*b + c")!.column).toBe(2);
    expect(byLabel.get("tanh(a*b + c)")!.column).toBe(3);
    for (const [from, to] of g.edges) {
      expect(g.nodes[from]!.x + BOX.width).toBeLessThan(g.nodes[to]!.op!.cx - g.nodes[to]!.op!.width / 2);
    }
    expect(g.edges).toHaveLength(5);
  });

  it("keeps every node inside the canvas without overlaps", () => {
    const { output } = run("sigmoid(w1*x1 + w2*x2 + b) * exp(-x1) + log(w1^2 + 1)", {
      w1: 0.5, x1: 1, w2: -1, x2: 2, b: 0.1,
    });
    const g = layout(output);
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + BOX.width).toBeLessThanOrEqual(g.width);
      expect(n.y + BOX.height).toBeLessThanOrEqual(g.height);
      if (n.op) expect(n.op.cx - n.op.width / 2).toBeGreaterThanOrEqual(0);
    }
    for (const a of g.nodes) {
      for (const b of g.nodes) {
        if (a === b || a.column !== b.column) continue;
        expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(BOX.height);
      }
    }
  });

  it("draws one edge per distinct input, even for a*a", () => {
    const g = layout(run("a*a", { a: 3 }).output);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([[0, 1]]);
  });

  it("refuses graphs too big to read", () => {
    // 31 inputs and 30 additions make 61 nodes.
    const big = Array.from({ length: 31 }, (_, i) => `x${i}`).join("+");
    expect(() => layout(run(big, Object.fromEntries(variables(parse(big)).map((n) => [n, 1]))).output)).toThrow(
      `the viewer draws up to ${MAX_GRAPH_NODES}`,
    );
  });

  it("op symbols", () => {
    const a = new Value(2);
    expect(opSymbol(a.mul(a))).toBe("×");
    expect(opSymbol(a.div(a))).toBe("÷");
    expect(opSymbol(a.sub(a))).toBe("−");
    expect(opSymbol(a.add(a))).toBe("+");
    expect(opSymbol(a.pow(3))).toBe("^3");
    expect(opSymbol(a.pow(a))).toBe("^");
    expect(opSymbol(Value.sum([a, a]))).toBe("Σ");
    expect(opSymbol(a.sigmoid())).toBe("sigmoid");
  });
});

describe("SVG output", () => {
  it("shows data and grad on every node", () => {
    const { output } = run("tanh(a*b + c)", { a: 2, b: -0.5, c: 0.25 });
    const svg = renderSvg(output);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg.match(/class="cg-node /g)).toHaveLength(6);
    expect(svg.match(/class="cg-op"/g)).toHaveLength(3);
    expect(svg).toContain(">data 2.0000<");
    expect(svg).toContain(">data -0.6351<");
    expect(svg).toContain(">grad -0.2983<");
    expect(svg).toContain(">grad 1.1932<");
    expect(svg).toContain(">grad 0.5966<");
    expect(svg).toContain(">grad 1.0000<");
    expect(svg).toContain('class="cg-node cg-output"');
    expect(svg).toContain('class="cg-node cg-input"');
    expect(svg).toContain(">tanh<");
    expect(svg).toContain('aria-label="Computation graph of tanh(a*b + c)"');
  });

  it("marks constants and grad signs", () => {
    const svg = renderSvg(run("2*a - relu(-a)", { a: 1 }).output);
    expect(svg).toContain('class="cg-node cg-const"');
    expect(svg).toContain("cg-grad cg-pos");
    expect(svg).toContain("cg-grad cg-zero");
    const neg = renderSvg(run("-a", { a: 1 }).output);
    expect(neg).toContain("cg-grad cg-neg");
  });

  it("escapes text and truncates long labels", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
    const v = new Value(1, [], "", "<script>");
    expect(renderSvg(v)).not.toContain("<script>");
    const long = run("sigmoid(alpha*beta + gamma*delta)", { alpha: 1, beta: 1, gamma: 1, delta: 1 }).output;
    expect(renderSvg(long)).toContain(">sigmoid(alpha*beta …<");
  });

  it("formats numbers compactly", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1)).toBe("1.0000");
    expect(formatNumber(-0.29833)).toBe("-0.2983");
    expect(formatNumber(123456)).toBe("1.23e+5");
    expect(formatNumber(0.00001234)).toBe("1.23e-5");
  });
});
