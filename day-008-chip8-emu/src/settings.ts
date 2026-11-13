import { DEFAULT_CYCLES_PER_FRAME, MAX_CYCLES_PER_FRAME } from "./machine";
import { DEFAULT_QUIRKS, QUIRK_INFO, type Quirks } from "./quirks";

export interface Settings {
  quirks: Quirks;
  cyclesPerFrame: number;
  onColor: string;
  offColor: string;
  muted: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  quirks: { ...DEFAULT_QUIRKS },
  cyclesPerFrame: DEFAULT_CYCLES_PER_FRAME,
  onColor: "#ffc933",
  offColor: "#1b1408",
  muted: false,
};

/** Speed slider stops, in cycles per frame. Fine-grained at the slow end where games live. */
export const SPEED_STEPS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1000,
];

/** The slider stop closest to a cycles-per-frame value. */
export function speedStepFor(cyclesPerFrame: number): number {
  let best = 0;
  SPEED_STEPS.forEach((value, k) => {
    if (Math.abs(value - cyclesPerFrame) < Math.abs(SPEED_STEPS[best] - cyclesPerFrame)) best = k;
  });
  return best;
}

const STORAGE_KEY = "chip8-emu:settings";
const COLOR = /^#[0-9a-f]{6}$/i;

type Store = Pick<Storage, "getItem" | "setItem">;

/** Read saved settings, keeping only fields that are present and valid. */
export function loadSettings(storage: Store | null | undefined): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS, quirks: { ...DEFAULT_SETTINGS.quirks } };
  let saved: Record<string, unknown>;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return settings;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return settings;
    saved = parsed as Record<string, unknown>;
  } catch {
    return settings;
  }
  const cpf = saved.cyclesPerFrame;
  if (typeof cpf === "number" && Number.isInteger(cpf) && cpf >= 1 && cpf <= MAX_CYCLES_PER_FRAME) {
    settings.cyclesPerFrame = cpf;
  }
  if (typeof saved.onColor === "string" && COLOR.test(saved.onColor)) settings.onColor = saved.onColor;
  if (typeof saved.offColor === "string" && COLOR.test(saved.offColor)) settings.offColor = saved.offColor;
  if (typeof saved.muted === "boolean") settings.muted = saved.muted;
  const quirks = saved.quirks as Record<string, unknown> | undefined;
  if (quirks && typeof quirks === "object") {
    for (const { key } of QUIRK_INFO) {
      if (typeof quirks[key] === "boolean") settings.quirks[key] = quirks[key];
    }
  }
  return settings;
}

export function saveSettings(storage: Store | null | undefined, settings: Settings): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or storage full: settings just won't persist.
  }
}

/** localStorage, or null where touching it throws (sandboxed iframes, some privacy modes). */
export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
