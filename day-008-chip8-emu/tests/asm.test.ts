import { describe, expect, it } from "vitest";
import { disassemble } from "../src/disasm";
import { AsmError, assemble } from "../tools/asm";

function words(rom: Uint8Array): number[] {
  const out: number[] = [];
  for (let k = 0; k < rom.length; k += 2) out.push((rom[k] << 8) | rom[k + 1]);
  return out;
}

describe("assembler", () => {
  it("round-trips every 16-bit word through the disassembler", () => {
    const failures: string[] = [];
    for (let op = 0; op <= 0xffff; op++) {
      const text = disassemble(op);
      const back = words(assemble(text))[0];
      if (back !== op) failures.push(`${op.toString(16)} -> ${text} -> ${back?.toString(16)}`);
    }
    expect(failures).toEqual([]);
  });

  it("resolves labels forwards and backwards", () => {
    const rom = assemble(`
      start:  JP end        ; forward
              CALL start    ; backward
      end:    JP start
    `);
    expect(words(rom)).toEqual([0x1204, 0x2200, 0x1200]);
  });

  it("allows a label and an instruction on the same line, any case", () => {
    expect(words(assemble("top: ld v1, 0x2a\njp top"))).toEqual([0x612a, 0x1200]);
  });

  it("emits DB bytes and keeps addresses right after odd-length data", () => {
    const rom = assemble(`
              LD I, sprite
              JP after
      sprite: DB 0b10000001, 0xFF, 7
      after:  CLS
    `);
    expect(Array.from(rom)).toEqual([0xa2, 0x04, 0x12, 0x07, 0x81, 0xff, 0x07, 0x00, 0xe0]);
  });

  it("accepts the one-operand shift forms", () => {
    expect(words(assemble("SHR V3\nSHL V4"))).toEqual([0x8336, 0x844e]);
  });

  it("ignores comments and blank lines", () => {
    expect(assemble("; nothing here\n\n   ; still nothing")).toHaveLength(0);
  });

  describe("errors", () => {
    it.each([
      ["JP nowhere", /line 1: unknown label or bad number "nowhere"/],
      ["LD V0, 0x100", /out of range/],
      ["DRW V0, V1, 16", /out of range/],
      ["JP 0x1000", /out of range/],
      ["DB 256", /out of range/],
      ["DB", /DB needs at least one value/],
      ["\nFOO V0", /line 2: cannot assemble "FOO V"/],
      ["LD V0", /cannot assemble "LD V"/],
      ["JP V1, 0x200", /JP with an offset only takes V0/],
      ["a: CLS\na: CLS", /line 2: duplicate label "a"/],
    ])("%j fails with %s", (source, message) => {
      expect(() => assemble(source)).toThrow(message);
      expect(() => assemble(source)).toThrow(AsmError);
    });

    it("rejects programs that do not fit in memory", () => {
      expect(() => assemble("CLS\n".repeat(1793))).toThrow(/too big/);
    });
  });
});
