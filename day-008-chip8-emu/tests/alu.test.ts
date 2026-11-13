import { describe, expect, it } from "vitest";
import { Cpu, UnknownOpcodeError, mathRandom, seededRandom } from "../src/cpu";
import type { Quirks } from "../src/quirks";
import { rom } from "./helpers";

/** Set VX and VY, run one 8XYN opcode, return the CPU. */
function alu(op: number, vx: number, vy: number, quirks: Partial<Quirks> = {}): Cpu {
  const cpu = new Cpu({ quirks });
  cpu.load(rom(op));
  const x = (op >> 8) & 0xf;
  const y = (op >> 4) & 0xf;
  cpu.v[x] = vx;
  if (y !== x) cpu.v[y] = vy;
  cpu.step();
  return cpu;
}

describe("8XY0-8XY3 copy and logic", () => {
  it("8XY0 copies VY into VX", () => {
    expect(alu(0x8120, 0x11, 0x22).v[1]).toBe(0x22);
  });

  it.each([
    [0x8121, 0b1100, 0b1010, 0b1110],
    [0x8122, 0b1100, 0b1010, 0b1000],
    [0x8123, 0b1100, 0b1010, 0b0110],
  ])("%s computes the logic op", (op, a, b, expected) => {
    expect(alu(op, a, b).v[1]).toBe(expected);
  });

  describe.each([0x8121, 0x8122, 0x8123])("VF reset quirk on %s", (op) => {
    it("resets VF to 0 when on", () => {
      const cpu = new Cpu({ quirks: { vfReset: true } });
      cpu.load(rom(0x6f07, op));
      cpu.step();
      cpu.step();
      expect(cpu.v[0xf]).toBe(0);
    });

    it("leaves VF alone when off", () => {
      const cpu = new Cpu({ quirks: { vfReset: false } });
      cpu.load(rom(0x6f07, op));
      cpu.step();
      cpu.step();
      expect(cpu.v[0xf]).toBe(7);
    });
  });
});

describe("8XY4 add with carry", () => {
  it("adds without carry", () => {
    const cpu = alu(0x8124, 0x10, 0x20);
    expect(cpu.v[1]).toBe(0x30);
    expect(cpu.v[0xf]).toBe(0);
  });

  it("wraps and sets VF on carry", () => {
    const cpu = alu(0x8124, 0xff, 0x02);
    expect(cpu.v[1]).toBe(0x01);
    expect(cpu.v[0xf]).toBe(1);
  });

  it("treats exactly 0x100 as a carry", () => {
    const cpu = alu(0x8124, 0x80, 0x80);
    expect(cpu.v[1]).toBe(0);
    expect(cpu.v[0xf]).toBe(1);
  });

  it("writes the flag after the result when X is F", () => {
    expect(alu(0x8f14, 0xff, 0x01).v[0xf]).toBe(1);
    expect(alu(0x8f14, 0x01, 0x01).v[0xf]).toBe(0);
  });

  it("uses VF as an operand before overwriting it", () => {
    const cpu = alu(0x81f4, 0xf0, 0x20);
    expect(cpu.v[1]).toBe(0x10);
    expect(cpu.v[0xf]).toBe(1);
  });
});

describe("8XY5 and 8XY7 subtract with borrow", () => {
  it("8XY5 sets VF to 1 when there is no borrow", () => {
    const cpu = alu(0x8125, 0x30, 0x10);
    expect(cpu.v[1]).toBe(0x20);
    expect(cpu.v[0xf]).toBe(1);
  });

  it("8XY5 sets VF to 1 when the operands are equal", () => {
    const cpu = alu(0x8125, 0x42, 0x42);
    expect(cpu.v[1]).toBe(0);
    expect(cpu.v[0xf]).toBe(1);
  });

  it("8XY5 wraps and clears VF on borrow", () => {
    const cpu = alu(0x8125, 0x10, 0x30);
    expect(cpu.v[1]).toBe(0xe0);
    expect(cpu.v[0xf]).toBe(0);
  });

  it("8XY7 computes VY - VX", () => {
    const cpu = alu(0x8127, 0x10, 0x30);
    expect(cpu.v[1]).toBe(0x20);
    expect(cpu.v[0xf]).toBe(1);
  });

  it("8XY7 wraps and clears VF on borrow", () => {
    const cpu = alu(0x8127, 0x30, 0x10);
    expect(cpu.v[1]).toBe(0xe0);
    expect(cpu.v[0xf]).toBe(0);
  });

  it("8XY7 sets VF to 1 when the operands are equal", () => {
    expect(alu(0x8127, 5, 5).v[0xf]).toBe(1);
  });

  it("flags win over results when X is F", () => {
    expect(alu(0x8f15, 0x10, 0x30).v[0xf]).toBe(0);
    expect(alu(0x8f17, 0x10, 0x30).v[0xf]).toBe(1);
  });
});

describe("8XY6 and 8XYE shifts", () => {
  describe("with shift-uses-VY on (COSMAC VIP)", () => {
    const quirks = { shiftUsesVY: true };

    it("8XY6 shifts VY right into VX", () => {
      const cpu = alu(0x8126, 0xff, 0b0000_0101, quirks);
      expect(cpu.v[1]).toBe(0b0000_0010);
      expect(cpu.v[2]).toBe(0b0000_0101);
      expect(cpu.v[0xf]).toBe(1);
    });

    it("8XY6 sets VF to 0 when the low bit was 0", () => {
      expect(alu(0x8126, 0xff, 0b0000_0100, quirks).v[0xf]).toBe(0);
    });

    it("8XYE shifts VY left into VX", () => {
      const cpu = alu(0x812e, 0x00, 0b1000_0011, quirks);
      expect(cpu.v[1]).toBe(0b0000_0110);
      expect(cpu.v[0xf]).toBe(1);
    });

    it("8XYE sets VF to 0 when the high bit was 0", () => {
      const cpu = alu(0x812e, 0xff, 0b0100_0000, quirks);
      expect(cpu.v[1]).toBe(0b1000_0000);
      expect(cpu.v[0xf]).toBe(0);
    });
  });

  describe("with shift-uses-VY off (SUPER-CHIP)", () => {
    const quirks = { shiftUsesVY: false };

    it("8XY6 shifts VX in place and ignores VY", () => {
      const cpu = alu(0x8126, 0b0000_0111, 0xff, quirks);
      expect(cpu.v[1]).toBe(0b0000_0011);
      expect(cpu.v[0xf]).toBe(1);
    });

    it("8XYE shifts VX in place and ignores VY", () => {
      const cpu = alu(0x812e, 0b0100_0001, 0xff, quirks);
      expect(cpu.v[1]).toBe(0b1000_0010);
      expect(cpu.v[0xf]).toBe(0);
    });
  });

  it("flag wins when shifting into VF", () => {
    expect(alu(0x8f06, 0, 0b10, { shiftUsesVY: true }).v[0xf]).toBe(0);
    expect(alu(0x8f0e, 0, 0x80, { shiftUsesVY: true }).v[0xf]).toBe(1);
  });
});

describe("8XYN unknown variants", () => {
  it.each([0x8128, 0x8129, 0x812a, 0x812b, 0x812c, 0x812d, 0x812f])("%s is reported", (op) => {
    expect(() => alu(op, 0, 0)).toThrow(UnknownOpcodeError);
  });
});

describe("CXNN random", () => {
  it("is reproducible with a seeded RNG", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const seqA = Array.from({ length: 8 }, a);
    expect(Array.from({ length: 8 }, b)).toEqual(seqA);
    expect(seqA.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)).toBe(true);
    expect(new Set(seqA).size).toBeGreaterThan(1);
  });

  it("different seeds give different sequences", () => {
    const a = Array.from({ length: 8 }, seededRandom(1));
    const b = Array.from({ length: 8 }, seededRandom(2));
    expect(a).not.toEqual(b);
  });

  it("stores the next random byte masked with NN", () => {
    const expected = seededRandom(7)();
    const cpu = new Cpu({ random: seededRandom(7) });
    cpu.load(rom(0xc30f));
    cpu.step();
    expect(cpu.v[3]).toBe(expected & 0x0f);
  });

  it("CX00 always yields 0", () => {
    const cpu = new Cpu({ random: () => 0xff });
    cpu.load(rom(0xc300));
    cpu.step();
    expect(cpu.v[3]).toBe(0);
  });

  it("falls back to Math.random bytes", () => {
    for (let k = 0; k < 50; k++) {
      const n = mathRandom();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(255);
      expect(Number.isInteger(n)).toBe(true);
    }
  });
});
