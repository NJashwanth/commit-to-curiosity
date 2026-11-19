/**
 * The computation graph viewer: parse an expression like `tanh(a*b + c)`,
 * build it out of Values, run backward, and lay the graph out as an SVG
 * string. Nothing here touches the DOM, so it is all testable in Node.
 */
import { AutogradError, Value } from "./engine";

// ---------------------------------------------------------------- parsing ---

export const FUNCTIONS = ["exp", "log", "tanh", "relu", "sigmoid"] as const;
export type FunctionName = (typeof FUNCTIONS)[number];
export type BinaryOp = "+" | "-" | "*" | "/" | "^";

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "neg"; arg: Expr }
  | { kind: "bin"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "call"; fn: FunctionName; arg: Expr };

export class ParseError extends Error {
  constructor(
    message: string,
    /** 0-based character offset of the problem. */
    readonly position: number,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

interface Token {
  type: "num" | "id" | "op" | "(" | ")" | "end";
  text: string;
  pos: number;
}

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
export const MAX_EXPRESSION_LENGTH = 200;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const num = NUMBER.exec(rest);
    if (num) {
      tokens.push({ type: "num", text: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    const id = IDENT.exec(rest);
    if (id) {
      tokens.push({ type: "id", text: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    if (rest.startsWith("**")) {
      tokens.push({ type: "op", text: "^", pos: i });
      i += 2;
      continue;
    }
    if ("+-*/^".includes(ch)) tokens.push({ type: "op", text: ch, pos: i });
    else if (ch === "(" || ch === ")") tokens.push({ type: ch, text: ch, pos: i });
    else throw new ParseError(`Unexpected character '${ch}' at position ${i + 1}`, i);
    i++;
  }
  tokens.push({ type: "end", text: "", pos: src.length });
  return tokens;
}

const describe = (t: Token): string => (t.type === "end" ? "the end of the expression" : `'${t.text}'`);

/**
 * Parses with the usual precedence, loosest first:
 *   + -   (left to right)
 *   * /   (left to right)
 *   unary minus
 *   ^     (right to left, so a^b^c = a^(b^c), and -a^2 = -(a^2))
 *   numbers, variables, f(...) and (...)
 */
export function parse(src: string): Expr {
  if (src.length > MAX_EXPRESSION_LENGTH) {
    throw new ParseError(`Expression is too long (${src.length} characters, max ${MAX_EXPRESSION_LENGTH})`, 0);
  }
  const tokens = tokenize(src);
  let k = 0;
  const peek = () => tokens[k]!;
  const take = () => tokens[k++]!;
  const isOp = (...ops: string[]) => peek().type === "op" && ops.includes(peek().text);

  function expression(): Expr {
    let left = term();
    while (isOp("+", "-")) {
      const op = take().text as BinaryOp;
      left = { kind: "bin", op, left, right: term() };
    }
    return left;
  }

  function term(): Expr {
    let left = unary();
    while (isOp("*", "/")) {
      const op = take().text as BinaryOp;
      left = { kind: "bin", op, left, right: unary() };
    }
    return left;
  }

  function unary(): Expr {
    if (isOp("-")) {
      take();
      const arg = unary();
      // Fold a minus sign into a number literal, so -2 is one constant node.
      return arg.kind === "num" ? { kind: "num", value: -arg.value } : { kind: "neg", arg };
    }
    return power();
  }

  function power(): Expr {
    const base = primary();
    if (isOp("^")) {
      take();
      return { kind: "bin", op: "^", left: base, right: unary() };
    }
    return base;
  }

  function primary(): Expr {
    const t = take();
    if (t.type === "num") {
      const value = Number(t.text);
      if (!Number.isFinite(value)) throw new ParseError(`Number ${t.text} is too large`, t.pos);
      return { kind: "num", value };
    }
    if (t.type === "id") {
      const isFn = (FUNCTIONS as readonly string[]).includes(t.text);
      if (peek().type === "(") {
        if (!isFn) {
          throw new ParseError(`Unknown function '${t.text}'; available: ${FUNCTIONS.join(", ")}`, t.pos);
        }
        take();
        const arg = expression();
        expect(")", t);
        return { kind: "call", fn: t.text as FunctionName, arg };
      }
      if (isFn) throw new ParseError(`'${t.text}' is a function; write ${t.text}(...)`, t.pos);
      return { kind: "var", name: t.text };
    }
    if (t.type === "(") {
      const inner = expression();
      expect(")", t);
      return inner;
    }
    throw new ParseError(
      `Expected a number, variable, function or '(' at position ${t.pos + 1}, but found ${describe(t)}`,
      t.pos,
    );
  }

  function expect(type: ")", open: Token): void {
    if (peek().type !== type) {
      const t = peek();
      throw new ParseError(
        `Expected ')' to close the '(' at position ${src.indexOf("(", open.pos) + 1}, but found ${describe(t)}`,
        t.pos,
      );
    }
    take();
  }

  const result = expression();
  const t = peek();
  if (t.type !== "end") throw new ParseError(`Unexpected ${describe(t)} at position ${t.pos + 1}`, t.pos);
  return result;
}

/** Variable names in order of first appearance. */
export function variables(expr: Expr): string[] {
  const names: string[] = [];
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case "var":
        if (!names.includes(e.name)) names.push(e.name);
        return;
      case "num":
        return;
      case "neg":
      case "call":
        return walk(e.arg);
      case "bin":
        walk(e.left);
        walk(e.right);
    }
  };
  walk(expr);
  return names;
}

const PRECEDENCE = { "+": 1, "-": 1, "*": 2, "/": 2, neg: 3, "^": 4, atom: 5 } as const;

function precedence(e: Expr): number {
  switch (e.kind) {
    case "bin":
      return PRECEDENCE[e.op];
    case "neg":
      return PRECEDENCE.neg;
    case "num":
      return e.value < 0 ? PRECEDENCE.neg : PRECEDENCE.atom;
    default:
      return PRECEDENCE.atom;
  }
}

/** Prints an expression back with only the parentheses it needs. */
export function format(e: Expr): string {
  const wrap = (sub: Expr, needed: boolean) => (needed ? `(${format(sub)})` : format(sub));
  switch (e.kind) {
    case "num":
      return String(e.value);
    case "var":
      return e.name;
    case "call":
      return `${e.fn}(${format(e.arg)})`;
    case "neg":
      return `-${wrap(e.arg, precedence(e.arg) < PRECEDENCE.neg)}`;
    case "bin": {
      const p = PRECEDENCE[e.op];
      const lp = precedence(e.left);
      const rp = precedence(e.right);
      if (e.op === "^") return `${wrap(e.left, lp <= p)}^${wrap(e.right, rp < PRECEDENCE.neg)}`;
      // Left-associative: the right side needs parens at equal precedence for - and /.
      const rightNeeds = e.op === "-" || e.op === "/" ? rp <= p : rp < p;
      const sep = p === 1 ? ` ${e.op} ` : e.op;
      return `${wrap(e.left, lp < p)}${sep}${wrap(e.right, rightNeeds)}`;
    }
  }
}

// ------------------------------------------------------------ evaluation ----

export interface Built {
  output: Value;
  /** One leaf Value per variable, shared by every place it is used. */
  inputs: Map<string, Value>;
}

/**
 * Builds the expression out of Values. Each variable becomes one leaf, so
 * `a*a` uses the same node twice and its grad shows both contributions.
 * Intermediate nodes are labelled with the sub-expression they compute.
 */
export function build(expr: Expr, values: Readonly<Record<string, number>>): Built {
  const inputs = new Map<string, Value>();
  const walk = (e: Expr): Value => {
    switch (e.kind) {
      case "num":
        return new Value(e.value, [], "", String(e.value));
      case "var": {
        let v = inputs.get(e.name);
        if (!v) {
          const x = values[e.name];
          if (x === undefined || !Number.isFinite(x)) throw new AutogradError(`No value for variable '${e.name}'`);
          v = new Value(x, [], "", e.name);
          inputs.set(e.name, v);
        }
        return v;
      }
      default: {
        const out = apply(e, walk);
        out.label = format(e);
        return out;
      }
    }
  };
  return { output: walk(expr), inputs };
}

function apply(e: Expr & { kind: "neg" | "bin" | "call" }, walk: (e: Expr) => Value): Value {
  if (e.kind === "neg") return walk(e.arg).neg();
  if (e.kind === "call") return walk(e.arg)[e.fn]();
  const left = walk(e.left);
  if (e.op === "^") return left.pow(e.right.kind === "num" ? e.right.value : walk(e.right));
  const right = walk(e.right);
  switch (e.op) {
    case "+":
      return left.add(right);
    case "-":
      return left.sub(right);
    case "*":
      return left.mul(right);
    case "/":
      return left.div(right);
  }
}

/** Parse, build and run backward in one go. */
export function run(src: string, values: Readonly<Record<string, number>>): Built & { expr: Expr } {
  const expr = parse(src);
  const built = build(expr, values);
  built.output.backward();
  return { ...built, expr };
}

// ---------------------------------------------------------------- layout ----

export const MAX_GRAPH_NODES = 60;

export const BOX = { width: 150, height: 58 } as const;
const OP_GAP = 34; // from an op pill's right edge to its box
const COL_GAP = 46; // from a box's right edge to the next column's op pill
const ROW_GAP = 26;
const PAD = 16;

export interface PlacedNode {
  value: Value;
  column: number;
  /** Top-left corner of the data box. */
  x: number;
  y: number;
  /** The op pill to the left of the box, for nodes that have an op. */
  op?: { symbol: string; cx: number; cy: number; width: number };
}

export interface GraphLayout {
  nodes: PlacedNode[];
  /** Index pairs into `nodes`: parent (input) to child (the node it feeds). */
  edges: [number, number][];
  width: number;
  height: number;
}

export function opSymbol(v: Value): string {
  switch (v.op) {
    case "*":
      return "×";
    case "/":
      return "÷";
    case "-":
      return "−";
    case "^":
      return v.parents.length === 1 ? `^${v.exponent}` : "^";
    case "sum":
      return "Σ";
    default:
      return v.op;
  }
}

const pillWidth = (symbol: string) => Math.max(34, 14 + 7.5 * symbol.length);

/**
 * Columns run left to right from inputs to output. A node's column is one
 * more than its deepest input; a leaf sits just left of its first consumer,
 * so a late input like `c` in tanh(a*b + c) doesn't drag a long edge. Within
 * a column, nodes are ordered by the height of the nodes they feed, working
 * back from the output, which keeps edges mostly straight.
 */
export function layout(root: Value): GraphLayout {
  const order = root.topo();
  if (order.length > MAX_GRAPH_NODES) {
    throw new AutogradError(`This expression makes ${order.length} nodes; the viewer draws up to ${MAX_GRAPH_NODES}`);
  }
  const index = new Map(order.map((v, i) => [v, i]));
  const consumers: number[][] = order.map(() => []);
  const edges: [number, number][] = [];
  order.forEach((v, i) => {
    for (const p of new Set(v.parents)) {
      edges.push([index.get(p)!, i]);
      consumers[index.get(p)!]!.push(i);
    }
  });

  const column = new Array<number>(order.length).fill(0);
  order.forEach((v, i) => {
    if (v.parents.length > 0) column[i] = 1 + Math.max(...v.parents.map((p) => column[index.get(p)!]!));
  });
  order.forEach((v, i) => {
    if (v.parents.length === 0 && consumers[i]!.length > 0) {
      column[i] = Math.min(...consumers[i]!.map((c) => column[c]!)) - 1;
    }
  });

  const columns = Math.max(...column) + 1;
  const pitch = BOX.height + ROW_GAP;
  const centreY = new Array<number>(order.length).fill(0);
  for (let c = columns - 1; c >= 0; c--) {
    const members = order.map((_, i) => i).filter((i) => column[i] === c);
    const want = (i: number) => {
      const cs = consumers[i]!;
      return cs.length === 0 ? 0 : cs.reduce((s, j) => s + centreY[j]!, 0) / cs.length;
    };
    members.sort((a, b) => want(a) - want(b) || a - b);
    // Stack them `pitch` apart, centred on the mean of where they want to be.
    const mean = members.reduce((s, i) => s + want(i), 0) / members.length;
    members.forEach((i, r) => (centreY[i] = mean + (r - (members.length - 1) / 2) * pitch));
  }

  const top = Math.min(...centreY) - BOX.height / 2;
  // Column 0 only holds leaves (anything with an op is at least column 1), so
  // every op pill fits in the gap between its column and the one before.
  const maxPill = Math.max(...order.map((v) => (v.op ? pillWidth(opSymbol(v)) : 0)));
  const colWidth = BOX.width + COL_GAP + maxPill + OP_GAP;
  const nodes: PlacedNode[] = order.map((value, i) => {
    const x = PAD + column[i]! * colWidth;
    const y = centreY[i]! - BOX.height / 2 - top + PAD;
    const node: PlacedNode = { value, column: column[i]!, x, y };
    if (value.op) {
      const symbol = opSymbol(value);
      const width = pillWidth(symbol);
      node.op = { symbol, cx: x - OP_GAP - width / 2, cy: y + BOX.height / 2, width };
    }
    return node;
  });
  const width = Math.max(...nodes.map((n) => n.x + BOX.width)) + PAD;
  const height = Math.max(...nodes.map((n) => n.y + BOX.height)) + PAD;
  return { nodes, edges, width, height };
}

// ------------------------------------------------------------------- SVG ----

export function formatNumber(x: number): string {
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1e5 || a < 1e-4) return x.toExponential(2);
  return x.toFixed(4);
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[c]};`);
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Renders the laid-out graph. Colours come from CSS classes on the page. */
export function renderSvg(root: Value, title = root.label): string {
  const g = layout(root);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="cgraph" viewBox="0 0 ${g.width} ${g.height}" ` +
      `width="${g.width}" height="${g.height}" role="img" aria-label="Computation graph of ${escapeXml(title)}">`,
    `<defs><marker id="cg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" ` +
      `orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="cg-arrowhead"/></marker></defs>`,
  );
  for (const [from, to] of g.edges) {
    const a = g.nodes[from]!;
    const b = g.nodes[to]!;
    const x1 = a.x + BOX.width;
    const y1 = a.y + BOX.height / 2;
    const x2 = b.op!.cx - b.op!.width / 2;
    const y2 = b.op!.cy;
    const mid = (x1 + x2) / 2;
    parts.push(`<path class="cg-edge" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 2},${y2}" marker-end="url(#cg-arrow)"/>`);
  }
  for (const n of g.nodes) {
    const v = n.value;
    if (n.op) {
      const { cx, cy, width, symbol } = n.op;
      parts.push(
        `<path class="cg-edge" d="M${cx + width / 2},${cy} L${n.x - 2},${cy}" marker-end="url(#cg-arrow)"/>`,
        `<g class="cg-op"><rect x="${cx - width / 2}" y="${cy - 13}" width="${width}" height="26" rx="13"/>` +
          `<text x="${cx}" y="${cy + 4}">${escapeXml(symbol)}</text></g>`,
      );
    }
    const kind = v === root ? "output" : v.parents.length > 0 ? "inner" : /^[A-Za-z_]/.test(v.label) ? "input" : "const";
    const sign = v.grad > 0 ? "pos" : v.grad < 0 ? "neg" : "zero";
    const tx = n.x + 10;
    parts.push(
      `<g class="cg-node cg-${kind}"><title>${escapeXml(v.label)}: data ${v.data}, grad ${v.grad}</title>` +
        `<rect x="${n.x}" y="${n.y}" width="${BOX.width}" height="${BOX.height}" rx="8"/>` +
        `<text class="cg-label" x="${tx}" y="${n.y + 17}">${escapeXml(truncate(v.label, 20))}</text>` +
        `<text class="cg-data" x="${tx}" y="${n.y + 34}">data ${formatNumber(v.data)}</text>` +
        `<text class="cg-grad cg-${sign}" x="${tx}" y="${n.y + 50}">grad ${formatNumber(v.grad)}</text></g>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}
