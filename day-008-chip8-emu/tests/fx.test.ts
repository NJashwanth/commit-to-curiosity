import { describe, expect, it } from "vitest";
import { Cpu, FONT_START, UnknownOpcodeError } from "../src/cpu";
import { cpuWith, rom, run } from "./helpers";

describe("timers", () => {
  it("FX15 sets the delay timer and FX07 reads it", () => {
    const cpu = run(cpuWith(0x6a2a, 0xfa15, 0xfb07), 3);
    expect(cpu.delayTimer).toBe(42);
    expect(cpu.v[0xb]).toBe(42);
  });

  it("FX18 sets the sound timer", () => {
    expect(run(cpuWith(0x6309, 0xf318), 2).soundTimer).toBe(9);
  });

  it("tickTimers counts both down and stops at zero", () => {
    const cpu = new Cpu();
    cpu.delayTimer = 2;
    cpu.soundTimer = 1;
    cpu.tickTimers();
    expect([cpu.delayTimer, cpu.soundTimer]).toEqual([1, 0]);
    cpu.tickTimers();
    cpu.tickTimers();
    expect([cpu.delayTimer, cpu.soundTimer]).toEqual([0, 0]);
  });

  it("instructions alone do not move the timers", () => {
    const cpu = cpuWith(0x6010, 0xf015, 0xf018, 0x1206);
    run(cpu, 100);
    expect(cpu.delayTimer).toBe(0x10);
    expect(cpu.soundTimer).toBe(0x10);
  });

  it("tickTimers also releases a display wait", () => {
    const cpu = new Cpu({ quirks: { displayWait: true } });
    cpu.load(rom(0xd001, 0xd001));
    run(cpu, 2);
    expect(cpu.blocked).toBe(true);
    cpu.tickTimers();
    expect(cpu.blocked).toBe(false);
  });
});

describe("EX9E and EXA1 key skips", () => {
  it("EX9E skips only when the key in VX is down", () => {
    const up = run(cpuWith(0x6105, 0xe19e), 2);
    expect(up.pc).toBe(0x204);
    const down = cpuWith(0x6105, 0xe19e);
    down.keyDown(5);
    run(down, 2);
    expect(down.pc).toBe(0x206);
  });

  it("EXA1 skips only when the key in VX is up", () => {
    const up = run(cpuWith(0x6105, 0xe1a1), 2);
    expect(up.pc).toBe(0x206);
    const down = cpuWith(0x6105, 0xe1a1);
    down.keyDown(5);
    run(down, 2);
    expect(down.pc).toBe(0x204);
  });

  it("uses only the low nibble of VX", () => {
    const cpu = cpuWith(0x61f5, 0xe19e);
    cpu.keyDown(5);
    expect(run(cpu, 2).pc).toBe(0x206);
  });

  it("other EXNN opcodes are unknown", () => {
    expect(() => run(cpuWith(0xe19f), 1)).toThrow(UnknownOpcodeError);
  });
});

describe("keypad", () => {
  it("tracks presses and releases", () => {
    const cpu = new Cpu();
    cpu.keyDown(0xa);
    expect(cpu.keys[0xa]).toBe(true);
    cpu.keyUp(0xa);
    expect(cpu.keys[0xa]).toBe(false);
  });

  it("ignores keys outside 0-F", () => {
    const cpu = new Cpu();
    cpu.keyDown(16);
    cpu.keyDown(-1);
    cpu.keyUp(16);
    expect(cpu.keys).toHaveLength(16);
    expect(cpu.keys.every((k) => !k)).toBe(true);
  });

  it("releaseAllKeys lifts every held key", () => {
    const cpu = new Cpu();
    cpu.keyDown(1);
    cpu.keyDown(0xf);
    cpu.releaseAllKeys();
    expect(cpu.keys.every((k) => !k)).toBe(true);
  });
});

describe("FX0A wait for key", () => {
  it("blocks until a key is pressed and released, then stores it", () => {
    const cpu = cpuWith(0xf30a, 0x6401);
    cpu.step();
    expect(cpu.waitingForKey).toBe(3);
    expect(cpu.blocked).toBe(true);
    run(cpu, 5);
    expect(cpu.pc).toBe(0x202);
    expect(cpu.v[4]).toBe(0);

    cpu.keyDown(0xb);
    expect(cpu.blocked).toBe(true); // a press alone is not enough
    cpu.keyUp(0xb);
    expect(cpu.blocked).toBe(false);
    expect(cpu.v[3]).toBe(0xb);
    cpu.step();
    expect(cpu.v[4]).toBe(1);
  });

  it("ignores a key that was already held when the wait started", () => {
    const cpu = cpuWith(0xf30a);
    cpu.keyDown(2);
    cpu.step();
    cpu.keyUp(2);
    expect(cpu.waitingForKey).toBe(3);
    cpu.keyDown(7);
    cpu.keyUp(7);
    expect(cpu.v[3]).toBe(7);
  });

  it("stores the first key pressed even if another is released first", () => {
    const cpu = cpuWith(0xf00a);
    cpu.step();
    cpu.keyDown(1);
    cpu.keyDown(2);
    cpu.keyUp(2);
    expect(cpu.blocked).toBe(true);
    cpu.keyUp(1);
    expect(cpu.v[0]).toBe(1);
  });

  it("does not tick timers or advance while waiting, and reset clears the wait", () => {
    const cpu = cpuWith(0xf00a);
    cpu.step();
    cpu.load(rom(0x6005));
    expect(cpu.blocked).toBe(false);
    cpu.step();
    expect(cpu.v[0]).toBe(5);
  });
});

describe("FX1E, FX29, FX33", () => {
  it("FX1E adds VX to I", () => {
    const cpu = run(cpuWith(0xa100, 0x6220, 0xf21e), 3);
    expect(cpu.i).toBe(0x120);
  });

  it("FX1E keeps I to 16 bits", () => {
    const cpu = cpuWith(0x62ff, 0xf21e);
    cpu.step();
    cpu.i = 0xfff0;
    cpu.step();
    expect(cpu.i).toBe(0x00ef);
  });

  it.each([
    [0x0, FONT_START],
    [0x1, FONT_START + 5],
    [0xa, FONT_START + 50],
    [0xf, FONT_START + 75],
  ])("FX29 points I at the glyph for %i", (digit, addr) => {
    const cpu = cpuWith(0x6500 | digit, 0xf529);
    expect(run(cpu, 2).i).toBe(addr);
  });

  it("FX29 uses only the low nibble", () => {
    expect(run(cpuWith(0x65ab, 0xf529), 2).i).toBe(FONT_START + 0xb * 5);
  });

  it.each([
    [254, [2, 5, 4]],
    [100, [1, 0, 0]],
    [42, [0, 4, 2]],
    [7, [0, 0, 7]],
    [0, [0, 0, 0]],
  ])("FX33 stores %i as BCD", (value, digits) => {
    const cpu = run(cpuWith(0xa300, 0x6600 | value, 0xf633), 3);
    expect(Array.from(cpu.memory.slice(0x300, 0x303))).toEqual(digits);
    expect(cpu.i).toBe(0x300);
  });
});

describe("FX55 and FX65 load/store", () => {
  function storeProgram(quirk: boolean): Cpu {
    const cpu = new Cpu({ quirks: { loadStoreIncrementsI: quirk } });
    cpu.load(rom(0xa300, 0x6011, 0x6122, 0x6233, 0x6344, 0xf255));
    return run(cpu, 6);
  }

  it("FX55 stores V0..VX inclusive at I", () => {
    const cpu = storeProgram(false);
    expect(Array.from(cpu.memory.slice(0x300, 0x304))).toEqual([0x11, 0x22, 0x33, 0]);
  });

  it("FX55 leaves I alone without the quirk", () => {
    expect(storeProgram(false).i).toBe(0x300);
  });

  it("FX55 advances I by X + 1 with the quirk", () => {
    expect(storeProgram(true).i).toBe(0x303);
  });

  function loadProgram(quirk: boolean): Cpu {
    const cpu = new Cpu({ quirks: { loadStoreIncrementsI: quirk } });
    cpu.load(rom(0xa300, 0xf365));
    cpu.memory.set([9, 8, 7, 6, 5], 0x300);
    return run(cpu, 2);
  }

  it("FX65 loads V0..VX inclusive from I", () => {
    const cpu = loadProgram(false);
    expect(Array.from(cpu.v.slice(0, 5))).toEqual([9, 8, 7, 6, 0]);
  });

  it("FX65 leaves I alone without the quirk", () => {
    expect(loadProgram(false).i).toBe(0x300);
  });

  it("FX65 advances I by X + 1 with the quirk", () => {
    expect(loadProgram(true).i).toBe(0x304);
  });

  it("F055 handles a single register", () => {
    const cpu = new Cpu({ quirks: { loadStoreIncrementsI: true } });
    cpu.load(rom(0xa300, 0x60aa, 0xf055));
    run(cpu, 3);
    expect(cpu.memory[0x300]).toBe(0xaa);
    expect(cpu.memory[0x301]).toBe(0);
    expect(cpu.i).toBe(0x301);
  });

  it("round-trips all 16 registers", () => {
    const cpu = new Cpu({ quirks: { loadStoreIncrementsI: false } });
    cpu.load(rom(0xa400, 0xff55, 0xff65));
    run(cpu, 1);
    cpu.v.set(Array.from({ length: 16 }, (_, k) => k * 3));
    cpu.step();
    const saved = Array.from(cpu.v);
    cpu.v.fill(0);
    cpu.step();
    expect(Array.from(cpu.v)).toEqual(saved);
  });

  it("wraps addresses past 0xFFF", () => {
    const cpu = new Cpu({ quirks: { loadStoreIncrementsI: false } });
    cpu.load(rom(0xafff, 0x6107, 0x6208, 0xf255));
    run(cpu, 4);
    expect(cpu.memory[0xfff]).toBe(0);
    expect(cpu.memory[0x000]).toBe(7);
    expect(cpu.memory[0x001]).toBe(8);
  });
});

describe("unknown FX opcodes", () => {
  it.each([0xf000, 0xf0ff, 0xf030, 0xf075])("%s is reported", (op) => {
    expect(() => run(cpuWith(op), 1)).toThrow(UnknownOpcodeError);
  });
});
