import { describe, expect, it } from "vitest";
import {
  Chip8Error,
  Cpu,
  STACK_DEPTH,
  StackOverflowError,
  StackUnderflowError,
  UnknownOpcodeError,
} from "../src/cpu";
import { cpuWith, rom, run } from "./helpers";

describe("1NNN jump", () => {
  it("sets PC to NNN", () => {
    expect(run(cpuWith(0x1abc), 1).pc).toBe(0xabc);
  });

  it("can jump to itself (the usual end-of-program loop)", () => {
    expect(run(cpuWith(0x1200), 5).pc).toBe(0x200);
  });
});

describe("2NNN call and 00EE return", () => {
  it("pushes the return address and jumps", () => {
    const cpu = run(cpuWith(0x2300), 1);
    expect(cpu.pc).toBe(0x300);
    expect(cpu.sp).toBe(1);
    expect(cpu.stack[0]).toBe(0x202);
  });

  it("returns to the instruction after the call", () => {
    const cpu = cpuWith(0x2206, 0x6107, 0x1204, 0x6005, 0x00ee);
    run(cpu, 3); // CALL, LD V0, RET
    expect(cpu.v[0]).toBe(5);
    expect(cpu.pc).toBe(0x202);
    expect(cpu.sp).toBe(0);
    cpu.step();
    expect(cpu.v[1]).toBe(7);
  });

  it("supports nesting up to 16 calls deep", () => {
    // 0x200: CALL 0x200 calls itself until the stack is full.
    const cpu = run(cpuWith(0x2200), STACK_DEPTH);
    expect(cpu.sp).toBe(16);
    expect(Array.from(cpu.stack)).toEqual(new Array(16).fill(0x202));
  });

  it("raises a clear error on the 17th nested call", () => {
    const cpu = run(cpuWith(0x2200), STACK_DEPTH);
    let caught: unknown;
    try {
      cpu.step();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StackOverflowError);
    expect(caught).toBeInstanceOf(Chip8Error);
    expect((caught as Error).message).toBe(
      "Stack overflow: more than 16 nested calls at 0x200 (opcode 2200)",
    );
    expect(cpu.sp).toBe(16);
    expect(cpu.pc).toBe(0x200);
  });

  it("raises a clear error when returning with an empty stack", () => {
    const cpu = cpuWith(0x6001, 0x00ee);
    cpu.step();
    expect(() => cpu.step()).toThrow(StackUnderflowError);
    expect(() => cpu.step()).toThrow("Stack underflow: return with an empty stack at 0x202 (opcode 00EE)");
    expect(cpu.sp).toBe(0);
    expect(cpu.pc).toBe(0x202);
  });
});

describe("skips", () => {
  /** Run a two-instruction program: the skip, then whatever follows. Returns PC after the skip. */
  function pcAfter(setup: number[], skipOp: number): number {
    const cpu = cpuWith(...setup, skipOp);
    run(cpu, setup.length + 1);
    return cpu.pc - (0x200 + setup.length * 2);
  }

  it("3XNN skips when VX == NN", () => {
    expect(pcAfter([0x6342], 0x3342)).toBe(4);
    expect(pcAfter([0x6342], 0x3343)).toBe(2);
  });

  it("4XNN skips when VX != NN", () => {
    expect(pcAfter([0x6342], 0x4343)).toBe(4);
    expect(pcAfter([0x6342], 0x4342)).toBe(2);
  });

  it("5XY0 skips when VX == VY", () => {
    expect(pcAfter([0x6109, 0x6209], 0x5120)).toBe(4);
    expect(pcAfter([0x6109, 0x6208], 0x5120)).toBe(2);
  });

  it("9XY0 skips when VX != VY", () => {
    expect(pcAfter([0x6109, 0x6208], 0x9120)).toBe(4);
    expect(pcAfter([0x6109, 0x6209], 0x9120)).toBe(2);
  });

  it("5XYN and 9XYN with N != 0 are unknown", () => {
    expect(() => run(cpuWith(0x5121), 1)).toThrow(UnknownOpcodeError);
    expect(() => run(cpuWith(0x912f), 1)).toThrow(UnknownOpcodeError);
  });

  it("a skip at the end of memory wraps PC", () => {
    const cpu = new Cpu();
    cpu.memory[0xffc] = 0x30;
    cpu.memory[0xffd] = 0x00;
    cpu.pc = 0xffc;
    cpu.step();
    expect(cpu.pc).toBe(0x000);
  });
});

describe("BNNN jump with offset", () => {
  it("jumps to NNN + V0 by default", () => {
    const cpu = new Cpu({ quirks: { jumpUsesVX: false } });
    cpu.load(rom(0x6010, 0x6320, 0xb300));
    run(cpu, 3);
    expect(cpu.pc).toBe(0x310);
  });

  it("jumps to XNN + VX with the jump quirk", () => {
    const cpu = new Cpu({ quirks: { jumpUsesVX: true } });
    cpu.load(rom(0x6010, 0x6320, 0xb300));
    run(cpu, 3);
    expect(cpu.pc).toBe(0x320);
  });

  it("wraps past the end of memory", () => {
    const cpu = new Cpu();
    cpu.load(rom(0x60ff, 0xbfff));
    run(cpu, 2);
    expect(cpu.pc).toBe(0x0fe);
  });
});
