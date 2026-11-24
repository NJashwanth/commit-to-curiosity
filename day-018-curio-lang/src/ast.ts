// Abstract syntax tree. Every node carries the 1-based line/col of its defining token
// (the operator for binary expressions, the `(` for calls) so runtime errors can point at it.

export interface Pos {
  line: number;
  col: number;
}

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=";
export type UnaryOp = "-" | "!";
export type LogicalOp = "and" | "or";

export type Expr =
  | { kind: "Number"; value: number; pos: Pos }
  | { kind: "String"; value: string; pos: Pos }
  | { kind: "Bool"; value: boolean; pos: Pos }
  | { kind: "Nil"; pos: Pos }
  | { kind: "Ident"; name: string; pos: Pos }
  | { kind: "Unary"; op: UnaryOp; operand: Expr; pos: Pos }
  | { kind: "Binary"; op: BinaryOp; left: Expr; right: Expr; pos: Pos }
  | { kind: "Logical"; op: LogicalOp; left: Expr; right: Expr; pos: Pos }
  | { kind: "Assign"; target: Expr; value: Expr; pos: Pos }
  | { kind: "Call"; callee: Expr; args: Expr[]; pos: Pos }
  | { kind: "Index"; object: Expr; index: Expr; pos: Pos }
  | { kind: "Function"; name: string | null; params: string[]; body: Block; pos: Pos }
  | { kind: "Array"; elements: Expr[]; pos: Pos }
  | { kind: "Map"; entries: { key: Expr; value: Expr }[]; pos: Pos }
  | { kind: "Template"; parts: (string | Expr)[]; pos: Pos };

export type Stmt =
  | { kind: "Let"; name: string; init: Expr | null; pos: Pos }
  | { kind: "ExprStmt"; expr: Expr; pos: Pos }
  | { kind: "Block"; body: Stmt[]; pos: Pos }
  | { kind: "If"; cond: Expr; then: Block; otherwise: Block | IfStmt | null; pos: Pos }
  | { kind: "While"; cond: Expr; body: Block; pos: Pos }
  | { kind: "For"; variable: string; iterable: Expr; body: Block; pos: Pos }
  | { kind: "Return"; value: Expr | null; pos: Pos }
  | { kind: "Break"; pos: Pos }
  | { kind: "Continue"; pos: Pos };

export type Block = Extract<Stmt, { kind: "Block" }>;
export type IfStmt = Extract<Stmt, { kind: "If" }>;

export interface Program {
  kind: "Program";
  body: Stmt[];
  pos: Pos;
}

export type Node = Expr | Stmt | Program;

/** Compact S-expression form of an expression, used by tests and debugging: `(+ 1 (* 2 3))`. */
export function toSexpr(e: Expr): string {
  switch (e.kind) {
    case "Number":
      return String(e.value);
    case "String":
      return JSON.stringify(e.value);
    case "Bool":
      return String(e.value);
    case "Nil":
      return "nil";
    case "Ident":
      return e.name;
    case "Unary":
      return `(${e.op} ${toSexpr(e.operand)})`;
    case "Binary":
    case "Logical":
      return `(${e.op} ${toSexpr(e.left)} ${toSexpr(e.right)})`;
    case "Assign":
      return `(= ${toSexpr(e.target)} ${toSexpr(e.value)})`;
    case "Call":
      return `(call ${[e.callee, ...e.args].map(toSexpr).join(" ")})`;
    case "Index":
      return `(index ${toSexpr(e.object)} ${toSexpr(e.index)})`;
    case "Function":
      return `(fn ${e.name ?? "_"} (${e.params.join(" ")}))`;
    case "Array":
      return `(array${e.elements.map((x) => " " + toSexpr(x)).join("")})`;
    case "Map":
      return `(map${e.entries.map((x) => ` ${toSexpr(x.key)} ${toSexpr(x.value)}`).join("")})`;
    case "Template":
      return `(template${e.parts.map((x) => " " + (typeof x === "string" ? JSON.stringify(x) : toSexpr(x))).join("")})`;
  }
}

type Child = [role: string | null, node: Node];

const e_name = (name: string | null) => name ?? "<anonymous>";

function describe(n: Node): { label: string; children: Child[] } {
  switch (n.kind) {
    case "Number":
      return { label: `Number ${n.value}`, children: [] };
    case "String":
      return { label: `String ${JSON.stringify(n.value)}`, children: [] };
    case "Bool":
      return { label: `Bool ${n.value}`, children: [] };
    case "Nil":
      return { label: "Nil", children: [] };
    case "Ident":
      return { label: `Ident ${n.name}`, children: [] };
    case "Unary":
      return { label: `Unary ${n.op}`, children: [[null, n.operand]] };
    case "Binary":
    case "Logical":
      return { label: `${n.kind} ${n.op}`, children: [[null, n.left], [null, n.right]] };
    case "Assign":
      return { label: "Assign", children: [["target", n.target], ["value", n.value]] };
    case "Call":
      return { label: "Call", children: [["callee", n.callee], ...n.args.map((a): Child => ["arg", a])] };
    case "Index":
      return { label: "Index", children: [["object", n.object], ["index", n.index]] };
    case "Function":
      return { label: `Function ${e_name(n.name)}(${n.params.join(", ")})`, children: [["body", n.body]] };
    case "Array":
      return { label: "Array", children: n.elements.map((x): Child => [null, x]) };
    case "Map":
      return { label: "Map", children: n.entries.flatMap((x): Child[] => [["key", x.key], ["value", x.value]]) };
    case "Template":
      return {
        label: "Template",
        children: n.parts.map((x): Child => (typeof x === "string" ? [null, { kind: "String", value: x, pos: n.pos }] : ["expr", x])),
      };
    case "Let":
      return { label: `Let ${n.name}`, children: n.init ? [[null, n.init]] : [] };
    case "ExprStmt":
      return { label: "ExprStmt", children: [[null, n.expr]] };
    case "Block":
    case "Program":
      return { label: n.kind, children: n.body.map((s): Child => [null, s]) };
    case "If": {
      const kids: Child[] = [["cond", n.cond], ["then", n.then]];
      if (n.otherwise) kids.push(["else", n.otherwise]);
      return { label: "If", children: kids };
    }
    case "While":
      return { label: "While", children: [["cond", n.cond], ["body", n.body]] };
    case "For":
      return { label: `For ${n.variable}`, children: [["in", n.iterable], ["body", n.body]] };
    case "Return":
      return { label: "Return", children: n.value ? [[null, n.value]] : [] };
    case "Break":
      return { label: "Break", children: [] };
    case "Continue":
      return { label: "Continue", children: [] };
  }
}

/** Indented tree view of any node, used for snapshot tests and the README: one node per line. */
export function dumpAst(node: Node, indent = 0): string {
  const { label, children } = describe(node);
  const lines = [`${"  ".repeat(indent)}${label}`];
  for (const [role, child] of children) {
    const sub = dumpAst(child, indent + 1).split("\n");
    if (role) sub[0] = `${"  ".repeat(indent + 1)}${role}: ${sub[0]!.trimStart()}`;
    lines.push(...sub);
  }
  return lines.join("\n");
}
