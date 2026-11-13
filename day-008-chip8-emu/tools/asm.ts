/**
 * A small two-pass CHIP-8 assembler for the ROMs in roms/. It reads the same
 * Cowgod-style mnemonics the disassembler prints, so the two round-trip.
 *
 *   ; comment
 *   label:  LD V0, 0x10     ; numbers: 0x1F, 0b0101, 31, or a label
 *           DRW V0, V1, 5
 *           JP label
 *   data:   DB 0b11110000, 0x90, 144
 *           DW 0x1234       ; a raw 16-bit word
 */

export class AsmError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "AsmError";
  }
}

type Kind = "V" | "I" | "[I]" | "DT" | "ST" | "K" | "F" | "B" | "imm";

interface Operand {
  kind: Kind;
  /** Register number for V, otherwise the raw text (a number or a label). */
  reg: number;
  text: string;
}

interface Statement {
  line: number;
  addr: number;
  mnemonic: string;
  operands: Operand[];
}

const ORIGIN = 0x200;

function parseOperand(raw: string): Operand {
  const text = raw.trim();
  const upper = text.toUpperCase();
  const reg = /^V([0-9A-F])$/.exec(upper);
  if (reg) return { kind: "V", reg: parseInt(reg[1], 16), text };
  if (["I", "[I]", "DT", "ST", "K", "F", "B"].includes(upper)) return { kind: upper as Kind, reg: 0, text };
  return { kind: "imm", reg: 0, text };
}

function parseNumber(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(t)) return parseInt(t.slice(2), 16);
  if (/^0b[01]+$/.test(t)) return parseInt(t.slice(2), 2);
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return null;
}

type Encoder = (ops: Operand[], value: (op: Operand, max: number) => number) => number;

const x = (ops: Operand[]) => ops[0].reg << 8;
const y = (ops: Operand[], k = 1) => ops[k].reg << 4;

/** Mnemonic plus operand kinds -> encoder. */
const ENCODERS: Record<string, Encoder> = {
  "CLS": () => 0x00e0,
  "RET": () => 0x00ee,
  "SYS imm": (o, v) => v(o[0], 0xfff),
  "JP imm": (o, v) => 0x1000 | v(o[0], 0xfff),
  "JP V,imm": (o, v) => {
    if (o[0].reg !== 0) throw new Error("JP with an offset only takes V0");
    return 0xb000 | v(o[1], 0xfff);
  },
  "CALL imm": (o, v) => 0x2000 | v(o[0], 0xfff),
  "SE V,imm": (o, v) => 0x3000 | x(o) | v(o[1], 0xff),
  "SNE V,imm": (o, v) => 0x4000 | x(o) | v(o[1], 0xff),
  "SE V,V": (o) => 0x5000 | x(o) | y(o),
  "SNE V,V": (o) => 0x9000 | x(o) | y(o),
  "LD V,imm": (o, v) => 0x6000 | x(o) | v(o[1], 0xff),
  "ADD V,imm": (o, v) => 0x7000 | x(o) | v(o[1], 0xff),
  "LD V,V": (o) => 0x8000 | x(o) | y(o),
  "OR V,V": (o) => 0x8001 | x(o) | y(o),
  "AND V,V": (o) => 0x8002 | x(o) | y(o),
  "XOR V,V": (o) => 0x8003 | x(o) | y(o),
  "ADD V,V": (o) => 0x8004 | x(o) | y(o),
  "SUB V,V": (o) => 0x8005 | x(o) | y(o),
  "SHR V,V": (o) => 0x8006 | x(o) | y(o),
  "SHR V": (o) => 0x8006 | x(o) | (o[0].reg << 4),
  "SUBN V,V": (o) => 0x8007 | x(o) | y(o),
  "SHL V,V": (o) => 0x800e | x(o) | y(o),
  "SHL V": (o) => 0x800e | x(o) | (o[0].reg << 4),
  "LD I,imm": (o, v) => 0xa000 | v(o[1], 0xfff),
  "RND V,imm": (o, v) => 0xc000 | x(o) | v(o[1], 0xff),
  "DRW V,V,imm": (o, v) => 0xd000 | x(o) | y(o) | v(o[2], 0xf),
  "SKP V": (o) => 0xe09e | x(o),
  "SKNP V": (o) => 0xe0a1 | x(o),
  "LD V,DT": (o) => 0xf007 | x(o),
  "LD V,K": (o) => 0xf00a | x(o),
  "LD DT,V": (o) => 0xf015 | (o[1].reg << 8),
  "LD ST,V": (o) => 0xf018 | (o[1].reg << 8),
  "ADD I,V": (o) => 0xf01e | (o[1].reg << 8),
  "LD F,V": (o) => 0xf029 | (o[1].reg << 8),
  "LD B,V": (o) => 0xf033 | (o[1].reg << 8),
  "LD [I],V": (o) => 0xf055 | (o[1].reg << 8),
  "LD V,[I]": (o) => 0xf065 | x(o),
  "DW imm": (o, v) => v(o[0], 0xffff),
};

/** Assemble source text into a ROM loaded at 0x200. */
export function assemble(source: string): Uint8Array {
  const labels = new Map<string, number>();
  const statements: Statement[] = [];
  let addr = ORIGIN;

  // Pass 1: find labels and the address of every statement.
  source.split("\n").forEach((rawLine, k) => {
    const line = k + 1;
    let text = rawLine.replace(/;.*/, "").trim();
    const label = /^([A-Za-z_][\w.-]*):/.exec(text);
    if (label) {
      if (labels.has(label[1])) throw new AsmError(`duplicate label "${label[1]}"`, line);
      labels.set(label[1], addr);
      text = text.slice(label[0].length).trim();
    }
    if (!text) return;
    const [mnemonic, ...rest] = text.split(/\s+/);
    const args = rest.join(" ");
    const operands = args ? args.split(",").map(parseOperand) : [];
    if (mnemonic.toUpperCase() === "DB") {
      if (operands.length === 0) throw new AsmError("DB needs at least one value", line);
      statements.push({ line, addr, mnemonic: "DB", operands });
      addr += operands.length;
    } else {
      statements.push({ line, addr, mnemonic: mnemonic.toUpperCase(), operands });
      addr += 2;
    }
  });

  const size = addr - ORIGIN;
  if (size > 0x1000 - ORIGIN) throw new AsmError(`program is ${size} bytes, too big for memory`, statements.at(-1)!.line);
  const out = new Uint8Array(size);

  // Pass 2: encode.
  for (const st of statements) {
    const value = (op: Operand, max: number): number => {
      const n = parseNumber(op.text) ?? labels.get(op.text);
      if (n === undefined) throw new AsmError(`unknown label or bad number "${op.text}"`, st.line);
      if (n > max) throw new AsmError(`${op.text} is out of range (max 0x${max.toString(16)})`, st.line);
      return n;
    };
    const at = st.addr - ORIGIN;
    if (st.mnemonic === "DB") {
      st.operands.forEach((op, k) => (out[at + k] = value(op, 0xff)));
      continue;
    }
    const signature = [st.mnemonic, st.operands.map((o) => o.kind).join(",")].filter(Boolean).join(" ");
    const encode = ENCODERS[signature];
    if (!encode) throw new AsmError(`cannot assemble "${signature}"`, st.line);
    let op: number;
    try {
      op = encode(st.operands, value);
    } catch (err) {
      if (err instanceof AsmError) throw err;
      throw new AsmError((err as Error).message, st.line);
    }
    out[at] = op >> 8;
    out[at + 1] = op & 0xff;
  }
  return out;
}
