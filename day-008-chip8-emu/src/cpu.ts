import { hex } from "./hex";
import { resolveQuirks, type Quirks } from "./quirks";

export const MEMORY_SIZE = 4096;
export const PROGRAM_START = 0x200;
export const MAX_ROM_SIZE = MEMORY_SIZE - PROGRAM_START;
export const FONT_START = 0x050;
export const FONT_GLYPH_BYTES = 5;
export const STACK_DEPTH = 16;

/** The built-in 4x5 hex font, one glyph per digit 0-F, loaded at FONT_START. */
export const FONT = Uint8Array.of(
  0xf0, 0x90, 0x90, 0x90, 0xf0, // 0
  0x20, 0x60, 0x20, 0x20, 0x70, // 1
  0xf0, 0x10, 0xf0, 0x80, 0xf0, // 2
  0xf0, 0x10, 0xf0, 0x10, 0xf0, // 3
  0x90, 0x90, 0xf0, 0x10, 0x10, // 4
  0xf0, 0x80, 0xf0, 0x10, 0xf0, // 5
  0xf0, 0x80, 0xf0, 0x90, 0xf0, // 6
  0xf0, 0x10, 0x20, 0x40, 0x40, // 7
  0xf0, 0x90, 0xf0, 0x90, 0xf0, // 8
  0xf0, 0x90, 0xf0, 0x10, 0xf0, // 9
  0xf0, 0x90, 0xf0, 0x90, 0x90, // A
  0xe0, 0x90, 0xe0, 0x90, 0xe0, // B
  0xf0, 0x80, 0x80, 0x80, 0xf0, // C
  0xe0, 0x90, 0x90, 0x90, 0xe0, // D
  0xf0, 0x80, 0xf0, 0x80, 0xf0, // E
  0xf0, 0x80, 0xf0, 0x80, 0x80, // F
);

/** An error raised while executing an instruction. `pc` is the instruction's address. */
export class Chip8Error extends Error {
  constructor(
    reason: string,
    readonly pc: number,
    readonly opcode: number,
  ) {
    super(`${reason} at 0x${hex(pc, 3)} (opcode ${hex(opcode, 4)})`);
    this.name = new.target.name;
  }
}

export class UnknownOpcodeError extends Chip8Error {
  constructor(pc: number, opcode: number) {
    super("Unknown opcode", pc, opcode);
  }
}

export class RomTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`ROM is ${size} bytes; the most that fits at 0x200 is ${MAX_ROM_SIZE}`);
    this.name = "RomTooLargeError";
  }
}

/** A source of random bytes (0-255). Inject a seeded one for reproducible runs. */
export type Random = () => number;

/** A small seeded PRNG (mulberry32) that returns bytes. Same seed, same sequence. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
}

export const mathRandom: Random = () => Math.floor(Math.random() * 256);

export interface CpuOptions {
  quirks?: Partial<Quirks>;
  random?: Random;
}

/** Decoded fields of a 16-bit opcode, named the way the CHIP-8 docs name them. */
interface Fields {
  op: number;
  x: number;
  y: number;
  n: number;
  nn: number;
  nnn: number;
}

export class Cpu {
  readonly memory = new Uint8Array(MEMORY_SIZE);
  /** General purpose registers V0-VF. VF doubles as the flag register. */
  readonly v = new Uint8Array(16);
  /** Index register, 16 bits wide. */
  i = 0;
  pc = PROGRAM_START;
  readonly stack = new Uint16Array(STACK_DEPTH);
  sp = 0;
  delayTimer = 0;
  soundTimer = 0;
  /** Interpreter quirks. Safe to change between instructions. */
  quirks: Quirks;
  random: Random;

  constructor(options: CpuOptions = {}) {
    this.quirks = resolveQuirks(options.quirks);
    this.random = options.random ?? mathRandom;
    this.reset();
  }

  /** Clear all state and load the font. Memory above the font is zeroed. */
  reset(): void {
    this.memory.fill(0);
    this.memory.set(FONT, FONT_START);
    this.v.fill(0);
    this.i = 0;
    this.pc = PROGRAM_START;
    this.stack.fill(0);
    this.sp = 0;
    this.delayTimer = 0;
    this.soundTimer = 0;
  }

  /** Reset, then copy a ROM into memory at 0x200. */
  load(rom: Uint8Array): void {
    if (rom.length > MAX_ROM_SIZE) throw new RomTooLargeError(rom.length);
    this.reset();
    this.memory.set(rom, PROGRAM_START);
  }

  /** Read the big-endian opcode at `addr` (defaults to PC) without executing it. */
  fetch(addr = this.pc): number {
    return (this.memory[addr & 0xfff] << 8) | this.memory[(addr + 1) & 0xfff];
  }

  /**
   * Run one instruction: fetch, advance PC, decode, execute.
   * If the instruction throws, PC is left pointing at it so a debugger shows the culprit.
   */
  step(): void {
    const at = this.pc;
    const op = this.fetch(at);
    this.pc = (at + 2) & 0xfff;
    try {
      this.execute({
        op,
        x: (op >> 8) & 0xf,
        y: (op >> 4) & 0xf,
        n: op & 0xf,
        nn: op & 0xff,
        nnn: op & 0xfff,
      });
    } catch (err) {
      this.pc = at;
      throw err;
    }
  }

  private execute(f: Fields): void {
    const { v } = this;
    switch (f.op >> 12) {
      case 0x0:
        // 0NNN SYS: a call into COSMAC VIP machine code. Modern interpreters ignore it.
        if (f.op === 0x00e0 || f.op === 0x00ee) break;
        return;
      case 0x6: // 6XNN  VX = NN
        v[f.x] = f.nn;
        return;
      case 0x7: // 7XNN  VX += NN (no carry flag)
        v[f.x] = (v[f.x] + f.nn) & 0xff;
        return;
      case 0x8:
        this.alu(f);
        return;
      case 0xa: // ANNN  I = NNN
        this.i = f.nnn;
        return;
      case 0xc: // CXNN  VX = random byte AND NN
        v[f.x] = this.random() & f.nn;
        return;
    }
    throw new UnknownOpcodeError((this.pc - 2) & 0xfff, f.op);
  }

  /** 8XYN: register-to-register arithmetic and logic. VF is written last, so it wins when X is F. */
  private alu(f: Fields): void {
    const { v, quirks } = this;
    const { x, y } = f;
    switch (f.n) {
      case 0x0: // 8XY0  VX = VY
        v[x] = v[y];
        return;
      case 0x1: // 8XY1  VX |= VY
        v[x] |= v[y];
        if (quirks.vfReset) v[0xf] = 0;
        return;
      case 0x2: // 8XY2  VX &= VY
        v[x] &= v[y];
        if (quirks.vfReset) v[0xf] = 0;
        return;
      case 0x3: // 8XY3  VX ^= VY
        v[x] ^= v[y];
        if (quirks.vfReset) v[0xf] = 0;
        return;
      case 0x4: {
        // 8XY4  VX += VY, VF = carry
        const sum = v[x] + v[y];
        v[x] = sum & 0xff;
        v[0xf] = sum > 0xff ? 1 : 0;
        return;
      }
      case 0x5: {
        // 8XY5  VX -= VY, VF = 1 when there is no borrow
        const [a, b] = [v[x], v[y]];
        v[x] = (a - b) & 0xff;
        v[0xf] = a >= b ? 1 : 0;
        return;
      }
      case 0x6: {
        // 8XY6  VX = source >> 1, VF = bit shifted out
        const src = quirks.shiftUsesVY ? v[y] : v[x];
        v[x] = src >> 1;
        v[0xf] = src & 1;
        return;
      }
      case 0x7: {
        // 8XY7  VX = VY - VX, VF = 1 when there is no borrow
        const [a, b] = [v[x], v[y]];
        v[x] = (b - a) & 0xff;
        v[0xf] = b >= a ? 1 : 0;
        return;
      }
      case 0xe: {
        // 8XYE  VX = source << 1, VF = bit shifted out
        const src = quirks.shiftUsesVY ? v[y] : v[x];
        v[x] = (src << 1) & 0xff;
        v[0xf] = src >> 7;
        return;
      }
    }
    throw new UnknownOpcodeError((this.pc - 2) & 0xfff, f.op);
  }
}
