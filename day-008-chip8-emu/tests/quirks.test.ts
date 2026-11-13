import { describe, expect, it } from "vitest";
import { Cpu } from "../src/cpu";
import {
  DEFAULT_QUIRKS,
  PRESETS,
  PRESET_LABELS,
  QUIRK_INFO,
  matchPreset,
  resolveQuirks,
  type PresetName,
} from "../src/quirks";

describe("quirks", () => {
  it("defaults to the original COSMAC VIP behaviour", () => {
    expect(DEFAULT_QUIRKS).toEqual(PRESETS.vip);
    expect(new Cpu().quirks).toEqual(PRESETS.vip);
  });

  it("fills in missing flags from the defaults", () => {
    const quirks = resolveQuirks({ shiftUsesVY: false });
    expect(quirks.shiftUsesVY).toBe(false);
    expect(quirks.loadStoreIncrementsI).toBe(DEFAULT_QUIRKS.loadStoreIncrementsI);
    expect(new Cpu({ quirks: { clipSprites: false } }).quirks.clipSprites).toBe(false);
  });

  it("does not share state between CPUs", () => {
    const a = new Cpu();
    a.quirks.vfReset = false;
    expect(new Cpu().quirks.vfReset).toBe(true);
    expect(DEFAULT_QUIRKS.vfReset).toBe(true);
  });

  it("describes every flag exactly once", () => {
    expect(QUIRK_INFO.map((q) => q.key).sort()).toEqual(Object.keys(DEFAULT_QUIRKS).sort());
  });

  it.each(Object.keys(PRESETS) as PresetName[])("recognises the %s preset", (name) => {
    expect(matchPreset({ ...PRESETS[name] })).toBe(name);
    expect(PRESET_LABELS[name]).toBeTruthy();
  });

  it("calls anything else custom", () => {
    expect(matchPreset({ ...PRESETS.vip, displayWait: false })).toBe("custom");
  });
});
