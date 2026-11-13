import { describe, expect, it } from "vitest";
import {
  Chip8Error,
  Cpu,
  FONT,
  FONT_START,
  MAX_ROM_SIZE,
  MEMORY_SIZE,
  PROGRAM_START,
  RomTooLargeError,
  UnknownOpcodeError,
} from "../src/cpu";
import { cpuWith, rom, run } from "./helpers";

describe("CPU state", () => {
  it("starts with 4KB of memory, 16 registers and PC at 0x200", () => {
    const cpu = new Cpu();
    expect(cpu.memory).toHaveLength(MEMORY_SIZE);
    expect(MEMORY_SIZE).toBe(4096);
    expect(cpu.v).toHaveLength(16);
    expect(cpu.stack).toHaveLength(16);
    expect(cpu.pc).toBe(0x200);
    expect(cpu.i).toBe(0);
    expect(cpu.sp).toBe(0);
    expect(cpu.delayTimer).toBe(0);
    expect(cpu.soundTimer).toBe(0);
  });

  it("loads the 80-byte font at 0x050", () => {
    const cpu = new Cpu();
    expect(FONT_START).toBe(0x050);
    expect(FONT).toHaveLength(80);
    expect(Array.from(cpu.memory.slice(0x50, 0x50 + 80))).toEqual(Array.from(FONT));
    // The glyph for 0 is a box: F0 90 90 90 F0.
    expect(Array.from(cpu.memory.slice(0x50, 0x55))).toEqual([0xf0, 0x90, 0x90, 0x90, 0xf0]);
    expect(cpu.memory[0x4f]).toBe(0);
    expect(cpu.memory[0xa0]).toBe(0);
  });

  it("loads a ROM at 0x200 and resets everything else", () => {
    const cpu = cpuWith(0x6005, 0xa123);
    run(cpu, 2);
    cpu.memory[0x500] = 0x77;
    cpu.load(rom(0x1234));
    expect(cpu.pc).toBe(PROGRAM_START);
    expect(cpu.v[0]).toBe(0);
    expect(cpu.i).toBe(0);
    expect(cpu.memory[0x200]).toBe(0x12);
    expect(cpu.memory[0x201]).toBe(0x34);
    expect(cpu.memory[0x202]).toBe(0);
    expect(cpu.memory[0x500]).toBe(0);
    expect(cpu.memory[FONT_START]).toBe(0xf0);
  });

  it("accepts a ROM that fills memory exactly and rejects a larger one", () => {
    const cpu = new Cpu();
    expect(() => cpu.load(new Uint8Array(MAX_ROM_SIZE))).not.toThrow();
    expect(() => cpu.load(new Uint8Array(MAX_ROM_SIZE + 1))).toThrow(RomTooLargeError);
    expect(() => cpu.load(new Uint8Array(MAX_ROM_SIZE + 1))).toThrow(/3585 bytes.*3584/);
  });
});

describe("fetch/decode/execute", () => {
  it("fetches big-endian opcodes without moving PC", () => {
    const cpu = cpuWith(0xa2f0);
    expect(cpu.fetch()).toBe(0xa2f0);
    expect(cpu.fetch(0x201)).toBe(0xf000);
    expect(cpu.pc).toBe(0x200);
  });

  it("wraps fetches and PC at the end of memory", () => {
    const cpu = new Cpu();
    cpu.memory[0xfff] = 0x60;
    cpu.memory[0x000] = 0x42;
    expect(cpu.fetch(0xfff)).toBe(0x6042);
    cpu.pc = 0xffe;
    cpu.memory[0xffe] = 0x61;
    cpu.memory[0xfff] = 0x07;
    cpu.step();
    expect(cpu.v[1]).toBe(7);
    expect(cpu.pc).toBe(0x000);
  });

  it("advances PC by 2 per instruction", () => {
    const cpu = run(cpuWith(0x6001, 0x6102, 0x6203), 3);
    expect(cpu.pc).toBe(0x206);
    expect(Array.from(cpu.v.slice(0, 3))).toEqual([1, 2, 3]);
  });

  it("6XNN sets VX", () => {
    const cpu = run(cpuWith(0x6aff, 0x6f12), 2);
    expect(cpu.v[0xa]).toBe(0xff);
    expect(cpu.v[0xf]).toBe(0x12);
  });

  it("7XNN adds NN to VX, wrapping at 8 bits without touching VF", () => {
    const cpu = run(cpuWith(0x60f0, 0x7020, 0x6f05, 0x7001), 4);
    expect(cpu.v[0]).toBe(0x11);
    expect(cpu.v[0xf]).toBe(0x05);
  });

  it("ANNN sets I", () => {
    const cpu = run(cpuWith(0xa123, 0xafff), 2);
    expect(cpu.i).toBe(0xfff);
  });

  it("0NNN (SYS) is ignored like on modern interpreters", () => {
    const cpu = run(cpuWith(0x0123), 1);
    expect(cpu.pc).toBe(0x202);
  });
});

describe("errors", () => {
  it("reports an unknown opcode with its address instead of skipping it", () => {
    const cpu = cpuWith(0x6001, 0x5121);
    cpu.step();
    let caught: unknown;
    try {
      cpu.step();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownOpcodeError);
    expect(caught).toBeInstanceOf(Chip8Error);
    const err = caught as UnknownOpcodeError;
    expect(err.pc).toBe(0x202);
    expect(err.opcode).toBe(0x5121);
    expect(err.message).toBe("Unknown opcode at 0x202 (opcode 5121)");
    expect(err.name).toBe("UnknownOpcodeError");
  });

  it("leaves PC on the faulting instruction", () => {
    const cpu = cpuWith(0xffff);
    expect(() => cpu.step()).toThrow(UnknownOpcodeError);
    expect(cpu.pc).toBe(0x200);
    // Stepping again reports the same instruction rather than moving past it.
    expect(() => cpu.step()).toThrow(/0x200/);
  });
});
