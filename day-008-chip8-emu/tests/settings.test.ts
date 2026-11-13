import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/quirks";
import {
  DEFAULT_SETTINGS,
  SPEED_STEPS,
  browserStorage,
  loadSettings,
  saveSettings,
  speedStepFor,
} from "../src/settings";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe("settings", () => {
  it("falls back to defaults with no storage or nothing saved", () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(new MemoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips through storage", () => {
    const storage = new MemoryStorage();
    const settings = {
      quirks: { ...PRESETS.schip },
      cyclesPerFrame: 200,
      onColor: "#00ff00",
      offColor: "#000000",
      muted: true,
    };
    saveSettings(storage, settings);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it("returns fresh objects that callers can mutate", () => {
    const a = loadSettings(null);
    a.quirks.vfReset = false;
    expect(loadSettings(null).quirks.vfReset).toBe(true);
    expect(DEFAULT_SETTINGS.quirks.vfReset).toBe(true);
  });

  it("keeps valid fields and drops invalid ones", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "chip8-emu:settings",
      JSON.stringify({
        cyclesPerFrame: 0,
        onColor: "red",
        offColor: "#123456",
        muted: "yes",
        quirks: { clipSprites: false, shiftUsesVY: "no", bogus: true },
      }),
    );
    const s = loadSettings(storage);
    expect(s.cyclesPerFrame).toBe(DEFAULT_SETTINGS.cyclesPerFrame);
    expect(s.onColor).toBe(DEFAULT_SETTINGS.onColor);
    expect(s.offColor).toBe("#123456");
    expect(s.muted).toBe(false);
    expect(s.quirks.clipSprites).toBe(false);
    expect(s.quirks.shiftUsesVY).toBe(DEFAULT_SETTINGS.quirks.shiftUsesVY);
    expect("bogus" in s.quirks).toBe(false);
  });

  it.each(["not json", "null", "42", '"text"'])("survives corrupt data %s", (raw) => {
    const storage = new MemoryStorage();
    storage.setItem("chip8-emu:settings", raw);
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadSettings(broken)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(broken, loadSettings(null))).not.toThrow();
  });

  it("browserStorage never throws, even outside a browser", () => {
    expect(() => browserStorage()).not.toThrow();
  });
});

describe("speed steps", () => {
  it("are sorted and include the default", () => {
    expect([...SPEED_STEPS].sort((a, b) => a - b)).toEqual(SPEED_STEPS);
    expect(SPEED_STEPS).toContain(DEFAULT_SETTINGS.cyclesPerFrame);
  });

  it("snap to the nearest stop", () => {
    expect(SPEED_STEPS[speedStepFor(15)]).toBe(15);
    expect(SPEED_STEPS[speedStepFor(14)]).toBe(15);
    expect(SPEED_STEPS[speedStepFor(11)]).toBe(10);
    expect(SPEED_STEPS[speedStepFor(5000)]).toBe(1000);
    expect(SPEED_STEPS[speedStepFor(0)]).toBe(1);
  });
});
