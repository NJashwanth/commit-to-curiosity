// Token definitions shared by the lexer and the parser.

export enum T {
  // Literals
  Number = "Number",
  String = "String",
  Template = "Template", // a string containing ${...} interpolations
  Ident = "Ident",

  // Keywords
  Let = "let",
  Fn = "fn",
  Return = "return",
  If = "if",
  Else = "else",
  While = "while",
  For = "for",
  In = "in",
  True = "true",
  False = "false",
  Nil = "nil",
  And = "and",
  Or = "or",
  Break = "break",
  Continue = "continue",

  // Operators
  Plus = "+",
  Minus = "-",
  Star = "*",
  Slash = "/",
  Percent = "%",
  Bang = "!",
  BangEq = "!=",
  Eq = "=",
  EqEq = "==",
  Lt = "<",
  Le = "<=",
  Gt = ">",
  Ge = ">=",

  // Punctuation
  LParen = "(",
  RParen = ")",
  LBrace = "{",
  RBrace = "}",
  LBracket = "[",
  RBracket = "]",
  Comma = ",",
  Semicolon = ";",
  Colon = ":",

  EOF = "EOF",
  /** Bad input (unknown character, unterminated string). The lexer has already reported it. */
  Error = "Error",
}

/** A piece of a template string: literal text, or the tokens of one `${...}` expression. */
export type TemplatePart = string | Token[];

export interface Token {
  type: T;
  /** The exact source text of the token (used for caret width in diagnostics). */
  lexeme: string;
  /** 1-based line of the first character. */
  line: number;
  /** 1-based column of the first character. */
  col: number;
  /** Decoded value for Number and String tokens. */
  value?: number | string;
  /** Parts of a Template token. Expression parts end with their own EOF token. */
  parts?: TemplatePart[];
}

export const KEYWORDS: ReadonlyMap<string, T> = new Map<string, T>([
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
]);

/** Human description of a token for error messages: `';'`, `identifier 'x'`, `end of input`. */
export function describeToken(tok: Token): string {
  switch (tok.type) {
    case T.EOF:
      return "end of input";
    case T.Ident:
      return `identifier '${tok.lexeme}'`;
    case T.Number:
      return `number ${tok.lexeme}`;
    case T.String:
    case T.Template:
      return "a string";
    default:
      return `'${tok.lexeme}'`;
  }
}
