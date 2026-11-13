/**
 * Behaviours that differ between CHIP-8 interpreters. Games were written
 * against whichever interpreter their author had, so one setting cannot run
 * everything correctly. Each flag is named for what happens when it is true.
 */
export interface Quirks {
  /** 8XY6/8XYE shift VY and store the result in VX (COSMAC VIP). Off: shift VX in place. */
  shiftUsesVY: boolean;
  /** FX55/FX65 leave I pointing past the last register (I += X + 1). Off: I is unchanged. */
  loadStoreIncrementsI: boolean;
  /** BXNN jumps to XNN + VX (SUPER-CHIP). Off: BNNN jumps to NNN + V0. */
  jumpUsesVX: boolean;
  /** 8XY1/8XY2/8XY3 reset VF to 0 (COSMAC VIP). */
  vfReset: boolean;
  /** DXYN waits for the next 60Hz vertical blank, so at most 60 sprites a second. */
  displayWait: boolean;
  /** Sprites that run off the edge are clipped. Off: they wrap to the other side. */
  clipSprites: boolean;
}

export type QuirkKey = keyof Quirks;
export type PresetName = "vip" | "octo" | "schip";

export const PRESETS: Record<PresetName, Quirks> = {
  /** The original 1977 COSMAC VIP interpreter. The reference behaviour. */
  vip: {
    shiftUsesVY: true,
    loadStoreIncrementsI: true,
    jumpUsesVX: false,
    vfReset: true,
    displayWait: true,
    clipSprites: true,
  },
  /** Octo's defaults, which most modern homebrew (including the CHIP-8 Archive) targets. */
  octo: {
    shiftUsesVY: true,
    loadStoreIncrementsI: true,
    jumpUsesVX: false,
    vfReset: false,
    displayWait: false,
    clipSprites: false,
  },
  /** SUPER-CHIP 1.1 on the HP48, which many 1990s games were written for. */
  schip: {
    shiftUsesVY: false,
    loadStoreIncrementsI: false,
    jumpUsesVX: true,
    vfReset: false,
    displayWait: false,
    clipSprites: true,
  },
};

export const PRESET_LABELS: Record<PresetName, string> = {
  vip: "CHIP-8 (COSMAC VIP)",
  octo: "Octo / modern CHIP-8",
  schip: "SUPER-CHIP",
};

/** Sensible default: behave like the original interpreter. */
export const DEFAULT_QUIRKS: Readonly<Quirks> = PRESETS.vip;

export const QUIRK_INFO: ReadonlyArray<{ key: QuirkKey; label: string; help: string }> = [
  { key: "shiftUsesVY", label: "Shift uses VY", help: "8XY6/8XYE shift VY into VX instead of shifting VX in place." },
  { key: "loadStoreIncrementsI", label: "Load/store increments I", help: "FX55/FX65 advance I by X + 1." },
  { key: "jumpUsesVX", label: "Jump with VX offset", help: "BXNN jumps to XNN + VX instead of NNN + V0." },
  { key: "vfReset", label: "VF reset", help: "8XY1/8XY2/8XY3 set VF to 0." },
  { key: "displayWait", label: "Display wait", help: "Drawing waits for the next 60Hz frame." },
  { key: "clipSprites", label: "Clip sprites", help: "Sprites are cut off at the edges instead of wrapping." },
];

/** Fill in any missing flags from the defaults. */
export function resolveQuirks(partial: Partial<Quirks> = {}): Quirks {
  return { ...DEFAULT_QUIRKS, ...partial };
}

/** The preset these flags match exactly, or "custom". */
export function matchPreset(quirks: Quirks): PresetName | "custom" {
  for (const name of Object.keys(PRESETS) as PresetName[]) {
    const preset = PRESETS[name];
    if (QUIRK_INFO.every(({ key }) => preset[key] === quirks[key])) return name;
  }
  return "custom";
}
