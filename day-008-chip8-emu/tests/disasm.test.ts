import { describe, expect, it } from "vitest";
import { Cpu } from "../src/cpu";
import { disassemble, disassembleAround, disassembleRange, explain, hexDump } from "../src/disasm";

/** One sample of every one of the 35 standard opcodes. */
export const SAMPLES: Array<[number, string]> = [
  [0x0123, "SYS 0x123"],
  [0x00e0, "CLS"],
  [0x00ee, "RET"],
  [0x1228, "JP 0x228"],
  [0x2abc, "CALL 0xABC"],
  [0x3a2f, "SE VA, 0x2F"],
  [0x4b00, "SNE VB, 0x00"],
  [0x5120, "SE V1, V2"],
  [0x6c0a, "LD VC, 0x0A"],
  [0x7dff, "ADD VD, 0xFF"],
  [0x8120, "LD V1, V2"],
  [0x8121, "OR V1, V2"],
  [0x8122, "AND V1, V2"],
  [0x8123, "XOR V1, V2"],
  [0x8124, "ADD V1, V2"],
  [0x8125, "SUB V1, V2"],
  [0x8126, "SHR V1, V2"],
  [0x8127, "SUBN V1, V2"],
  [0x812e, "SHL V1, V2"],
  [0x9ef0, "SNE VE, VF"],
  [0xa050, "LD I, 0x050"],
  [0xb300, "JP V0, 0x300"],
  [0xc70f, "RND V7, 0x0F"],
  [0xd01f, "DRW V0, V1, 15"],
  [0xe39e, "SKP V3"],
  [0xe3a1, "SKNP V3"],
  [0xf507, "LD V5, DT"],
  [0xf50a, "LD V5, K"],
  [0xf515, "LD DT, V5"],
  [0xf518, "LD ST, V5"],
  [0xf51e, "ADD I, V5"],
  [0xf529, "LD F, V5"],
  [0xf533, "LD B, V5"],
  [0xff55, "LD [I], VF"],
  [0xf065, "LD V0, [I]"],
];

describe("disassemble", () => {
  it("covers all 35 standard opcodes", () => {
    expect(SAMPLES).toHaveLength(35);
  });

  it.each(SAMPLES)("%s -> %s", (op, text) => {
    expect(disassemble(op)).toBe(text);
  });

  it.each([0x5121, 0x9121, 0x8128, 0x812f, 0xe100, 0xf000, 0xffff])(
    "shows unknown opcode %s as data",
    (op) => {
      expect(disassemble(op)).toMatch(/^DW 0x[0-9A-F]{4}$/);
    },
  );

  it("formats data words with 4 hex digits", () => {
    expect(disassemble(0x5121)).toBe("DW 0x5121");
  });
});

describe("explain", () => {
  it.each(SAMPLES)("explains %s", (op) => {
    const text = explain(op);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(3);
    expect(text).not.toMatch(/undefined/);
  });

  it("gives specific explanations", () => {
    expect(explain(0x00e0)).toBe("Clear the screen");
    expect(explain(0xd125)).toBe("Draw 5-row sprite from I at (V1, V2), VF = collision");
    expect(explain(0x8ab4)).toBe("VA += VB, VF = carry");
    expect(explain(0xf30a)).toBe("Wait for a key, store it in V3");
    expect(explain(0xe4a1)).toBe("Skip next if key V4 is up");
  });

  it("flags data", () => {
    expect(explain(0xffff)).toMatch(/Not an instruction/);
  });
});

describe("ranges", () => {
  const cpu = new Cpu();
  cpu.load(Uint8Array.of(0x00, 0xe0, 0xa2, 0x2a, 0x60, 0x0c, 0x12, 0x00));

  it("disassembles consecutive words", () => {
    expect(disassembleRange(cpu.memory, 0x200, 4)).toEqual([
      { addr: 0x200, op: 0x00e0, text: "CLS" },
      { addr: 0x202, op: 0xa22a, text: "LD I, 0x22A" },
      { addr: 0x204, op: 0x600c, text: "LD V0, 0x0C" },
      { addr: 0x206, op: 0x1200, text: "JP 0x200" },
    ]);
  });

  it("stops at the end of memory", () => {
    expect(disassembleRange(cpu.memory, 0xffc, 10).map((l) => l.addr)).toEqual([0xffc, 0xffe]);
  });

  it("centres on PC keeping its alignment", () => {
    const lines = disassembleAround(cpu.memory, 0x205, 2, 3);
    expect(lines.map((l) => l.addr)).toEqual([0x201, 0x203, 0x205, 0x207, 0x209, 0x20b]);
  });

  it("does not run before address 0", () => {
    const lines = disassembleAround(cpu.memory, 0x002, 4, 1);
    expect(lines.map((l) => l.addr)).toEqual([0x000, 0x002, 0x004]);
    expect(disassembleAround(cpu.memory, 0x003, 4, 0).map((l) => l.addr)).toEqual([0x001, 0x003]);
  });
});

describe("hexDump", () => {
  const memory = new Uint8Array(4096).map((_, k) => k & 0xff);

  it("dumps aligned rows", () => {
    expect(hexDump(memory, 0x203, 2, 8)).toEqual([
      { addr: 0x200, bytes: [0, 1, 2, 3, 4, 5, 6, 7] },
      { addr: 0x208, bytes: [8, 9, 10, 11, 12, 13, 14, 15] },
    ]);
  });

  it("clamps to the start and end of memory", () => {
    expect(hexDump(memory, -40, 1)[0].addr).toBe(0);
    const tail = hexDump(memory, 0xffe, 4, 8);
    expect(tail[0].addr).toBe(0xfe0);
    expect(tail[3].addr).toBe(0xff8);
    expect(tail[3].bytes).toHaveLength(8);
  });

  it("defaults to 8 columns", () => {
    expect(hexDump(memory, 0, 1)[0].bytes).toHaveLength(8);
  });
});
