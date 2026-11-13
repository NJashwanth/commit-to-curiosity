import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Cpu, MAX_ROM_SIZE, seededRandom } from "../src/cpu";
import { Machine } from "../src/machine";
import { BUILT_IN_ROMS, DEFAULT_ROM_ID, findRom, romUrl, type BuiltInRom } from "../src/roms";
import { assemble } from "../tools/asm";

const root = join(import.meta.dirname, "..");
const readRom = (file: string) => new Uint8Array(readFileSync(join(root, "public", "roms", file)));

function boot(rom: BuiltInRom, seed = 1): Machine {
  const cpu = new Cpu({ quirks: { ...rom.profile.quirks }, random: seededRandom(seed) });
  cpu.load(readRom(rom.file));
  return new Machine(cpu, rom.profile.cyclesPerFrame);
}

describe("catalog", () => {
  it("has unique ids and files that exist", () => {
    expect(new Set(BUILT_IN_ROMS.map((r) => r.id)).size).toBe(BUILT_IN_ROMS.length);
    for (const rom of BUILT_IN_ROMS) {
      const bytes = readRom(rom.file);
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThanOrEqual(MAX_ROM_SIZE);
    }
  });

  it("finds ROMs by id", () => {
    expect(findRom(DEFAULT_ROM_ID)?.title).toBe("J N demo");
    expect(findRom("nope")).toBeUndefined();
    expect(findRom(null)).toBeUndefined();
  });

  it("builds URLs under the site's base path", () => {
    const rom = findRom("snek")!;
    expect(romUrl(rom, "/")).toBe("/roms/snek.ch8");
    expect(romUrl(rom, "/commit-to-curiosity/chip8/")).toBe("/commit-to-curiosity/chip8/roms/snek.ch8");
    expect(romUrl(rom, "./")).toBe("./roms/snek.ch8");
    expect(romUrl(rom, "/base")).toBe("/base/roms/snek.ch8");
  });

  it("lists every bundled file with its SHA-256 in ROMS.md", () => {
    const doc = readFileSync(join(root, "ROMS.md"), "utf8");
    for (const rom of BUILT_IN_ROMS) {
      const sha = createHash("sha256").update(readRom(rom.file)).digest("hex");
      expect(doc, rom.file).toContain(rom.file);
      expect(doc, `${rom.file} checksum`).toContain(sha);
    }
  });

  it.each(BUILT_IN_ROMS.map((r) => [r.id, r] as const))("%s runs 20 seconds of play without errors", (_, rom) => {
    for (const seed of [1, 2, 3]) {
      const m = boot(rom, seed);
      const keys = seededRandom(seed + 100);
      for (let frame = 0; frame < 1200; frame++) {
        // Mash a random key every quarter second so menus and waits move on.
        if (frame % 15 === 0) {
          m.cpu.releaseAllKeys();
          m.cpu.keyDown(keys() & 0xf);
        }
        m.runFrame();
      }
      expect(m.cpu.display.pixels.some((p) => p === 1)).toBe(true);
    }
  });
});

describe("my ROMs", () => {
  it.each(["jn-demo", "keypad"])("public/roms/%s.ch8 matches roms/%s.asm (run npm run roms)", (name) => {
    const source = readFileSync(join(root, "roms", `${name}.asm`), "utf8");
    expect(Array.from(readRom(`${name}.ch8`))).toEqual(Array.from(assemble(source)));
  });
});

describe("J N demo", () => {
  const demo = findRom("jn-demo")!;
  const rows = (m: Machine) => m.cpu.display.toString().split("\n");

  it("draws J and N with a gap between them", () => {
    const m = boot(demo);
    for (let k = 0; k < 20; k++) m.runFrame();
    const r = rows(m);
    expect(r[2].slice(20, 28)).toBe("..######"); // top of the J
    expect(r[10].slice(20, 28)).toBe(".#####..");
    expect(r[2].slice(36, 44)).toBe("##....##"); // N
    expect(r[5].slice(36, 44)).toBe("##.##.##"); // the N's diagonal
    expect(r[5].slice(28, 36)).toBe("........"); // the space in "J N"
    expect(r[13]).toBe("#".repeat(64)); // divider
  });

  it("bounces a ball that stays in its box and beeps on the walls", () => {
    const m = boot(demo, 1);
    for (let k = 0; k < 10; k++) m.runFrame(); // letters, divider and ball setup
    let beeps = 0;
    const positions = new Set<string>();
    for (let k = 0; k < 600; k++) {
      m.runFrame();
      if (m.cpu.soundTimer === 2) beeps++; // each 3-tick beep passes 2 exactly once
      const [x, y] = [m.cpu.v[2], m.cpu.v[3]];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(60);
      expect(y).toBeGreaterThanOrEqual(15);
      expect(y).toBeLessThanOrEqual(28);
      positions.add(`${x},${y}`);
      // The letters and divider are never disturbed by the ball.
      expect(rows(m)[13]).toBe("#".repeat(64));
    }
    expect(positions.size).toBeGreaterThan(50);
    expect(beeps).toBeGreaterThan(3);
  });

  it("shows exactly one 12-pixel ball under the divider", () => {
    const m = boot(demo);
    for (let k = 0; k < 90; k++) m.runFrame();
    const lit = rows(m)
      .slice(14)
      .join("")
      .split("")
      .filter((c) => c === "#").length;
    expect(lit).toBe(12);
  });
});

describe("keypad test ROM", () => {
  it("shows the digit of the key pressed and released inside the box", () => {
    const m = boot(findRom("keypad")!);
    m.runFrame();
    expect(m.cpu.waitingForKey).toBe(0);
    m.cpu.keyDown(0xa);
    m.cpu.keyUp(0xa);
    m.runFrame();
    m.runFrame();
    const r = m.cpu.display.toString().split("\n");
    expect(r[10].slice(27, 35)).toBe("########");
    expect(r.slice(13, 18).map((row) => row.slice(29, 33))).toEqual(["####", "#..#", "####", "#..#", "#..#"]);
    expect(m.cpu.soundTimer).toBeGreaterThan(0);

    // A second key replaces the first.
    m.cpu.keyDown(0x1);
    m.cpu.keyUp(0x1);
    // Display wait: erasing and drawing the digit take a frame each.
    m.runFrame();
    m.runFrame();
    const r2 = m.cpu.display.toString().split("\n");
    expect(r2.slice(13, 18).map((row) => row.slice(29, 33))).toEqual(["..#.", ".##.", "..#.", "..#.", ".###"]);
  });
});
