import { Display } from "./display";
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

export class StackOverflowError extends Chip8Error {
  constructor(pc: number, opcode: number) {
    super(`Stack overflow: more than ${STACK_DEPTH} nested calls`, pc, opcode);
  }
}

export class StackUnderflowError extends Chip8Error {
  constructor(pc: number, opcode: number) {
    super("Stack underflow: return with an empty stack", pc, opcode);
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
  readonly display = new Display();
  /** True once a 60Hz frame has started since the last draw (display wait quirk). */
  private vblankReady = true;
  /** DXYN is blocked until the next vblank (display wait quirk). */
  waitingForVblank = false;

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
    this.display.clear();
    this.vblankReady = true;
    this.waitingForVblank = false;
  }

  /** Signal the start of a 60Hz frame. Releases a draw held by the display wait quirk. */
  vblank(): void {
    this.vblankReady = true;
    this.waitingForVblank = false;
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
    if (this.waitingForVblank) return;
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
        if (f.op === 0x00e0) {
          // 00E0  CLS
          this.display.clear();
          return;
        }
        if (f.op === 0x00ee) {
          // 00EE  RET: pop the return address
          if (this.sp === 0) throw new StackUnderflowError(this.at(), f.op);
          this.pc = this.stack[--this.sp];
          return;
        }
        // 0NNN SYS: a call into COSMAC VIP machine code. Modern interpreters ignore it.
        return;
      case 0x1: // 1NNN  JP NNN
        this.pc = f.nnn;
        return;
      case 0x2: // 2NNN  CALL NNN: push the return address, then jump
        if (this.sp === STACK_DEPTH) throw new StackOverflowError(this.at(), f.op);
        this.stack[this.sp++] = this.pc;
        this.pc = f.nnn;
        return;
      case 0x3: // 3XNN  skip if VX == NN
        if (v[f.x] === f.nn) this.skip();
        return;
      case 0x4: // 4XNN  skip if VX != NN
        if (v[f.x] !== f.nn) this.skip();
        return;
      case 0x5: // 5XY0  skip if VX == VY
        if (f.n !== 0) break;
        if (v[f.x] === v[f.y]) this.skip();
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
      case 0x9: // 9XY0  skip if VX != VY
        if (f.n !== 0) break;
        if (v[f.x] !== v[f.y]) this.skip();
        return;
      case 0xa: // ANNN  I = NNN
        this.i = f.nnn;
        return;
      case 0xb: // BNNN  jump to NNN + V0, or BXNN to XNN + VX with the jump quirk
        this.pc = (f.nnn + v[this.quirks.jumpUsesVX ? f.x : 0]) & 0xfff;
        return;
      case 0xc: // CXNN  VX = random byte AND NN
        v[f.x] = this.random() & f.nn;
        return;
      case 0xd:
        this.draw(f);
        return;
    }
    throw new UnknownOpcodeError(this.at(), f.op);
  }

  /** Address of the instruction being executed (PC has already moved past it). */
  private at(): number {
    return (this.pc - 2) & 0xfff;
  }

  private skip(): void {
    this.pc = (this.pc + 2) & 0xfff;
  }

  /** DXYN: XOR an N-row sprite from memory at I onto the screen at (VX, VY). VF = collision. */
  private draw(f: Fields): void {
    if (this.quirks.displayWait) {
      if (!this.vblankReady) {
        // Hold PC on this instruction until the next frame starts.
        this.pc = this.at();
        this.waitingForVblank = true;
        return;
      }
      this.vblankReady = false;
    }
    const rows: number[] = [];
    for (let r = 0; r < f.n; r++) rows.push(this.memory[(this.i + r) & 0xfff]);
    const hit = this.display.drawSprite(this.v[f.x], this.v[f.y], rows, this.quirks.clipSprites);
    this.v[0xf] = hit ? 1 : 0;
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
    throw new UnknownOpcodeError(this.at(), f.op);
  }
}
