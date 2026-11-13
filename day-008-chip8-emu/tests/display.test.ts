import { describe, expect, it } from "vitest";
import { Cpu, FONT_START } from "../src/cpu";
import { Display, HEIGHT, WIDTH, parseColor, toRGBA } from "../src/display";
import { rom, run } from "./helpers";

const BOX = [0xf0, 0x90, 0x90, 0xf0]; // 4x4 hollow square

/** The lit pixels as "x,y" strings, for compact assertions. */
function lit(d: Display): string[] {
  const out: string[] = [];
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (d.get(x, y)) out.push(`${x},${y}`);
  return out;
}

describe("Display", () => {
  it("is 64x32 and starts blank", () => {
    const d = new Display();
    expect(d.pixels).toHaveLength(64 * 32);
    expect(lit(d)).toEqual([]);
  });

  it("draws a sprite MSB-first, one byte per row", () => {
    const d = new Display();
    expect(d.drawSprite(2, 1, [0b1010_0000, 0b0100_0001], true)).toBe(false);
    expect(lit(d)).toEqual(["2,1", "4,1", "3,2", "9,2"]);
  });

  it("XORs pixels and reports a collision when one turns off", () => {
    const d = new Display();
    d.drawSprite(0, 0, BOX, true);
    expect(d.drawSprite(0, 0, [0xff], true)).toBe(true);
    // Row 0 was F0; XOR with FF leaves the right half on.
    expect(lit(d).filter((p) => p.endsWith(",0"))).toEqual(["4,0", "5,0", "6,0", "7,0"]);
  });

  it("drawing the same sprite twice erases it", () => {
    const d = new Display();
    d.drawSprite(10, 10, BOX, true);
    expect(d.drawSprite(10, 10, BOX, true)).toBe(true);
    expect(lit(d)).toEqual([]);
  });

  it("does not report a collision for overlapping zero bits", () => {
    const d = new Display();
    d.drawSprite(0, 0, [0xf0], true);
    expect(d.drawSprite(0, 0, [0x0f], true)).toBe(false);
  });

  it("wraps the starting position", () => {
    const d = new Display();
    d.drawSprite(64 + 3, 32 + 2, [0x80], true);
    expect(lit(d)).toEqual(["3,2"]);
  });

  it("clips pixels that run off the right and bottom edges", () => {
    const d = new Display();
    d.drawSprite(62, 30, [0xff, 0xff, 0xff, 0xff], true);
    expect(lit(d)).toEqual(["62,30", "63,30", "62,31", "63,31"]);
  });

  it("wraps pixels that run off the edges when clipping is off", () => {
    const d = new Display();
    d.drawSprite(62, 31, [0xe0, 0xe0], false);
    expect(lit(d).sort()).toEqual(["0,0", "0,31", "62,0", "62,31", "63,0", "63,31"].sort());
  });

  it("reports collisions on wrapped pixels", () => {
    const d = new Display();
    d.drawSprite(0, 0, [0x80], true);
    expect(d.drawSprite(63, 0, [0xc0], false)).toBe(true);
    expect(d.get(0, 0)).toBe(false);
  });

  it("marks itself dirty on draw and clear", () => {
    const d = new Display();
    d.dirty = false;
    d.drawSprite(0, 0, [0x80], true);
    expect(d.dirty).toBe(true);
    d.dirty = false;
    d.clear();
    expect(d.dirty).toBe(true);
    expect(lit(d)).toEqual([]);
  });

  it("renders as text", () => {
    const d = new Display();
    d.drawSprite(0, 0, [0xc0], true);
    const rows = d.toString().split("\n");
    expect(rows).toHaveLength(32);
    expect(rows[0]).toBe("##" + ".".repeat(62));
    expect(d.toString("1", "0").split("\n")[1]).toBe("0".repeat(64));
  });
});

describe("colors", () => {
  it("parses long and short hex colors", () => {
    expect(parseColor("#33ff66")).toEqual([0x33, 0xff, 0x66]);
    expect(parseColor("#3F6")).toEqual([0x33, 0xff, 0x66]);
    expect(parseColor(" 101820 ")).toEqual([0x10, 0x18, 0x20]);
  });

  it("rejects anything else", () => {
    expect(() => parseColor("red")).toThrow(/Not a hex color/);
    expect(() => parseColor("#12345")).toThrow();
  });

  it("converts the framebuffer to RGBA with on/off colors", () => {
    const d = new Display();
    d.drawSprite(1, 0, [0x80], true);
    const rgba = toRGBA(d, [255, 200, 0], [10, 20, 30]);
    expect(rgba).toHaveLength(64 * 32 * 4);
    expect(Array.from(rgba.slice(0, 8))).toEqual([10, 20, 30, 255, 255, 200, 0, 255]);
  });

  it("reuses the output buffer", () => {
    const out = new Uint8ClampedArray(64 * 32 * 4);
    expect(toRGBA(new Display(), [1, 1, 1], [0, 0, 0], out)).toBe(out);
  });
});

describe("00E0 and DXYN on the CPU", () => {
  it("00E0 clears the screen", () => {
    const cpu = new Cpu();
    cpu.load(rom(0x00e0));
    cpu.display.drawSprite(0, 0, BOX, true);
    cpu.step();
    expect(lit(cpu.display)).toEqual([]);
  });

  it("DXYN draws N bytes from I at (VX, VY) and clears VF", () => {
    const cpu = new Cpu();
    // I = font glyph 0, V0 = 5, V1 = 3, VF = 1 beforehand, draw 5 rows.
    cpu.load(rom(0xa050, 0x6005, 0x6103, 0x6f01, 0xd015));
    run(cpu, 5);
    expect(cpu.v[0xf]).toBe(0);
    expect(cpu.display.get(5, 3)).toBe(true);
    expect(cpu.display.get(9, 3)).toBe(false);
    expect(cpu.display.get(6, 4)).toBe(false); // the hollow middle of "0"
    expect(lit(cpu.display)).toHaveLength(14);
  });

  it("DXYN sets VF on collision and erases on redraw", () => {
    const cpu = new Cpu({ quirks: { displayWait: false } });
    cpu.load(rom(0xa050, 0xd015, 0xd015));
    run(cpu, 3);
    expect(cpu.v[0xf]).toBe(1);
    expect(lit(cpu.display)).toEqual([]);
  });

  it("DXY0 draws nothing", () => {
    const cpu = new Cpu();
    cpu.load(rom(0xa050, 0xd010));
    run(cpu, 2);
    expect(lit(cpu.display)).toEqual([]);
    expect(cpu.v[0xf]).toBe(0);
  });

  it("follows the clip quirk", () => {
    const program = rom(0xa050 + 8 * 5, 0x603e, 0x611e, 0xd015); // glyph 8 at (62, 30)
    const clipped = new Cpu({ quirks: { clipSprites: true } });
    clipped.load(program);
    run(clipped, 4);
    const wrapped = new Cpu({ quirks: { clipSprites: false } });
    wrapped.load(program);
    run(wrapped, 4);
    expect(lit(clipped.display)).toEqual(["62,30", "63,30", "62,31"]);
    expect(lit(wrapped.display)).toContain("0,0");
    expect(lit(wrapped.display)).toHaveLength(16);
  });

  it("reads sprite rows past 0xFFF by wrapping", () => {
    const cpu = new Cpu();
    cpu.load(rom(0xafff, 0xd002));
    cpu.memory[0xfff] = 0x80;
    cpu.memory[0x000] = 0x40;
    run(cpu, 2);
    expect(lit(cpu.display)).toEqual(["0,0", "1,1"]);
  });

  it("uses VF as a coordinate before overwriting it with the flag", () => {
    const cpu = new Cpu();
    cpu.load(rom(0xa050, 0x6f08, 0x6000, 0xdf01));
    run(cpu, 4);
    expect(cpu.display.get(8, 0)).toBe(true);
    expect(cpu.v[0xf]).toBe(0);
  });

  it("draws the font at 0x050", () => {
    expect(FONT_START).toBe(0x50);
    const cpu = new Cpu();
    cpu.load(rom(0xd005));
    cpu.i = FONT_START + 0xf * 5; // glyph F
    cpu.step();
    expect(cpu.display.toString().split("\n").slice(0, 5).map((r) => r.slice(0, 4))).toEqual([
      "####",
      "#...",
      "####",
      "#...",
      "#...",
    ]);
  });
});

describe("display wait quirk", () => {
  const program = rom(0xa050, 0xd005, 0x6101, 0xd005, 0x6102);

  it("allows one draw per frame and holds the second until vblank", () => {
    const cpu = new Cpu({ quirks: { displayWait: true } });
    cpu.load(program);
    run(cpu, 3); // LD I, DRW, LD V1
    cpu.step(); // second DRW blocks
    expect(cpu.waitingForVblank).toBe(true);
    expect(cpu.pc).toBe(0x206);
    expect(lit(cpu.display)).toHaveLength(14);
    run(cpu, 10); // still blocked: nothing happens
    expect(cpu.pc).toBe(0x206);
    cpu.vblank();
    expect(cpu.waitingForVblank).toBe(false);
    cpu.step(); // the draw goes through and erases the glyph
    expect(cpu.pc).toBe(0x208);
    expect(lit(cpu.display)).toEqual([]);
    expect(cpu.v[0xf]).toBe(1);
  });

  it("never blocks when off", () => {
    const cpu = new Cpu({ quirks: { displayWait: false } });
    cpu.load(program);
    run(cpu, 5);
    expect(cpu.waitingForVblank).toBe(false);
    expect(cpu.v[1]).toBe(2);
  });

  it("is cleared by reset", () => {
    const cpu = new Cpu({ quirks: { displayWait: true } });
    cpu.load(program);
    run(cpu, 4);
    expect(cpu.waitingForVblank).toBe(true);
    cpu.load(program);
    expect(cpu.waitingForVblank).toBe(false);
    run(cpu, 2);
    expect(lit(cpu.display)).toHaveLength(14);
  });
});
