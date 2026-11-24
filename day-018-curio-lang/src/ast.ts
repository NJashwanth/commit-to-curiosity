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
  | { kind: "Index"; object: Expr; index: Expr; pos: Pos };

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
  }
}
