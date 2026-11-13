import { hex } from "./hex";

/** Mnemonics follow Cowgod's widely used CHIP-8 reference. */
export function disassemble(op: number): string {
  const x = `V${hex((op >> 8) & 0xf, 1)}`;
  const y = `V${hex((op >> 4) & 0xf, 1)}`;
  const n = op & 0xf;
  const nn = `0x${hex(op & 0xff)}`;
  const nnn = `0x${hex(op & 0xfff, 3)}`;
  switch (op >> 12) {
    case 0x0:
      if (op === 0x00e0) return "CLS";
      if (op === 0x00ee) return "RET";
      return `SYS ${nnn}`;
    case 0x1:
      return `JP ${nnn}`;
    case 0x2:
      return `CALL ${nnn}`;
    case 0x3:
      return `SE ${x}, ${nn}`;
    case 0x4:
      return `SNE ${x}, ${nn}`;
    case 0x5:
      if (n === 0) return `SE ${x}, ${y}`;
      break;
    case 0x6:
      return `LD ${x}, ${nn}`;
    case 0x7:
      return `ADD ${x}, ${nn}`;
    case 0x8: {
      const alu = ALU_MNEMONICS[n];
      if (alu) return `${alu} ${x}, ${y}`;
      break;
    }
    case 0x9:
      if (n === 0) return `SNE ${x}, ${y}`;
      break;
    case 0xa:
      return `LD I, ${nnn}`;
    case 0xb:
      return `JP V0, ${nnn}`;
    case 0xc:
      return `RND ${x}, ${nn}`;
    case 0xd:
      return `DRW ${x}, ${y}, ${n}`;
    case 0xe:
      if ((op & 0xff) === 0x9e) return `SKP ${x}`;
      if ((op & 0xff) === 0xa1) return `SKNP ${x}`;
      break;
    case 0xf: {
      const form = MISC_FORMS[op & 0xff];
      if (form) return form.replace("X", x);
      break;
    }
  }
  return `DW 0x${hex(op, 4)}`;
}

const ALU_MNEMONICS: Record<number, string> = {
  0x0: "LD",
  0x1: "OR",
  0x2: "AND",
  0x3: "XOR",
  0x4: "ADD",
  0x5: "SUB",
  0x6: "SHR",
  0x7: "SUBN",
  0xe: "SHL",
};

const MISC_FORMS: Record<number, string> = {
  0x07: "LD X, DT",
  0x0a: "LD X, K",
  0x15: "LD DT, X",
  0x18: "LD ST, X",
  0x1e: "ADD I, X",
  0x29: "LD F, X",
  0x33: "LD B, X",
  0x55: "LD [I], X",
  0x65: "LD X, [I]",
};

/** A one-line plain-English explanation of an opcode, for the debugger. */
export function explain(op: number): string {
  const x = `V${hex((op >> 8) & 0xf, 1)}`;
  const y = `V${hex((op >> 4) & 0xf, 1)}`;
  const n = op & 0xf;
  const nn = `0x${hex(op & 0xff)}`;
  const nnn = `0x${hex(op & 0xfff, 3)}`;
  const text = disassemble(op);
  if (text.startsWith("DW")) return "Not an instruction (data, or an unknown opcode)";
  switch (op >> 12) {
    case 0x0:
      if (op === 0x00e0) return "Clear the screen";
      if (op === 0x00ee) return "Return from subroutine";
      return "Machine code call, ignored";
    case 0x1:
      return `Jump to ${nnn}`;
    case 0x2:
      return `Call subroutine at ${nnn}`;
    case 0x3:
      return `Skip next if ${x} == ${nn}`;
    case 0x4:
      return `Skip next if ${x} != ${nn}`;
    case 0x5:
      return `Skip next if ${x} == ${y}`;
    case 0x6:
      return `${x} = ${nn}`;
    case 0x7:
      return `${x} += ${nn}`;
    case 0x8:
      return {
        0x0: `${x} = ${y}`,
        0x1: `${x} |= ${y}`,
        0x2: `${x} &= ${y}`,
        0x3: `${x} ^= ${y}`,
        0x4: `${x} += ${y}, VF = carry`,
        0x5: `${x} -= ${y}, VF = no borrow`,
        0x6: `${x} = shift right, VF = bit out`,
        0x7: `${x} = ${y} - ${x}, VF = no borrow`,
        0xe: `${x} = shift left, VF = bit out`,
      }[n] as string;
    case 0x9:
      return `Skip next if ${x} != ${y}`;
    case 0xa:
      return `I = ${nnn}`;
    case 0xb:
      return `Jump to ${nnn} + V0 (or + VX with the jump quirk)`;
    case 0xc:
      return `${x} = random byte & ${nn}`;
    case 0xd:
      return `Draw ${n}-row sprite from I at (${x}, ${y}), VF = collision`;
    case 0xe:
      return (op & 0xff) === 0x9e ? `Skip next if key ${x} is down` : `Skip next if key ${x} is up`;
    default:
      return {
        0x07: `${x} = delay timer`,
        0x0a: `Wait for a key, store it in ${x}`,
        0x15: `Delay timer = ${x}`,
        0x18: `Sound timer = ${x}`,
        0x1e: `I += ${x}`,
        0x29: `I = font glyph for ${x}`,
        0x33: `Store ${x} as 3 decimal digits at I`,
        0x55: `Store V0..${x} at I`,
        0x65: `Load V0..${x} from I`,
      }[op & 0xff] as string;
  }
}

export interface DisasmLine {
  addr: number;
  op: number;
  text: string;
}

/** Disassemble `count` consecutive 2-byte words starting at `start`. */
export function disassembleRange(memory: Uint8Array, start: number, count: number): DisasmLine[] {
  const lines: DisasmLine[] = [];
  for (let k = 0; k < count; k++) {
    const addr = start + k * 2;
    if (addr > memory.length - 2) break;
    const op = (memory[addr] << 8) | memory[addr + 1];
    lines.push({ addr, op, text: disassemble(op) });
  }
  return lines;
}

/**
 * Lines around PC, keeping PC's alignment. CHIP-8 mixes code and data and
 * instructions can sit at odd addresses, so this can only guess what came
 * before PC: it disassembles in steps of 2 from PC backwards.
 */
export function disassembleAround(memory: Uint8Array, pc: number, before: number, after: number): DisasmLine[] {
  let start = pc - before * 2;
  while (start < 0) start += 2;
  const count = (pc - start) / 2 + after + 1;
  return disassembleRange(memory, start, count);
}

export interface DumpRow {
  addr: number;
  bytes: number[];
}

/** `rows` x `cols` bytes from `start`, clamped to the end of memory. */
export function hexDump(memory: Uint8Array, start: number, rows: number, cols = 8): DumpRow[] {
  const out: DumpRow[] = [];
  const first = Math.max(0, Math.min(start - (start % cols), memory.length - rows * cols));
  for (let r = 0; r < rows; r++) {
    const addr = first + r * cols;
    out.push({ addr, bytes: Array.from(memory.subarray(addr, addr + cols)) });
  }
  return out;
}
