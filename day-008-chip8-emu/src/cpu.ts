import { hex } from "./hex";

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

  constructor() {
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
      case 0xa: // ANNN  I = NNN
        this.i = f.nnn;
        return;
    }
    throw new UnknownOpcodeError((this.pc - 2) & 0xfff, f.op);
  }
}
