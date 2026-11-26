// The DOM-free half of the UI: which sliders exist, how their values read
// out, what a keypress means, and how a tap cycles a step's velocity.
import { DRUM_IDS, decayScale, tuneRatio } from "./drums";
import { feedbackGain, reverbSeconds } from "./effects";
import { MAX_SWING, MAX_TEMPO, MIN_TEMPO } from "./scheduler";
import { DELAY_DIVISIONS, PATTERN_COUNT, SYNTH_TRACK, TRACK_COUNT, type FxSettings } from "./state";
import { adsrFromKnobs, cutoffHz, envOctaves, glideSeconds, resonanceDb, type SynthParams } from "./synth";

export const SLOT_NAMES = ["A", "B", "C", "D"].slice(0, PATTERN_COUNT);

/** The four velocity levels a tap cycles through (of 16). */
export const VELOCITY_LEVELS = [4, 8, 12, 16] as const;

/** The next level above `vel`, wrapping from the loudest back to the softest. */
export function nextVelocity(vel: number): number {
  return VELOCITY_LEVELS.find((l) => l > vel) ?? VELOCITY_LEVELS[0];
}

export const fmtSeconds = (s: number): string => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(s < 10 ? 2 : 1)} s`);
export const fmtHz = (hz: number): string => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`);
export const fmtPercent = (v: number): string => `${Math.round(v)}%`;
export const fmtSigned = (v: number, unit: string): string => `${v > 0 ? "+" : ""}${v.toFixed(v === Math.round(v) ? 0 : 1)} ${unit}`;

export interface KnobSpec<K extends string = string> {
  key: K;
  label: string;
  /** Turn the 0..100 value into a readable label. */
  format: (v: number) => string;
}

type DrumKey = "tune" | "decay" | "level";
export const DRUM_KNOBS: KnobSpec<DrumKey>[] = [
  { key: "tune", label: "Tune", format: (v) => fmtSigned(Math.round(12 * Math.log2(tuneRatio(v))), "st") },
  { key: "decay", label: "Decay", format: (v) => `${decayScale(v).toFixed(2)}x` },
  { key: "level", label: "Level", format: fmtPercent },
];

type SynthKey = Exclude<keyof SynthParams, "wave">;
const adsr = (v: number) => adsrFromKnobs({ attack: v, decay: v, sustain: v, release: v });
export const SYNTH_KNOBS: KnobSpec<SynthKey>[] = [
  { key: "attack", label: "Attack", format: (v) => fmtSeconds(adsr(v).attack) },
  { key: "decay", label: "Decay", format: (v) => fmtSeconds(adsr(v).decay) },
  { key: "sustain", label: "Sustain", format: fmtPercent },
  { key: "release", label: "Release", format: (v) => fmtSeconds(adsr(v).release) },
  { key: "cutoff", label: "Cutoff", format: (v) => fmtHz(cutoffHz(v)) },
  { key: "resonance", label: "Resonance", format: (v) => `${resonanceDb(v).toFixed(1)} dB` },
  { key: "envAmt", label: "Filter env", format: (v) => `${envOctaves(v).toFixed(1)} oct` },
  { key: "glide", label: "Glide", format: (v) => fmtSeconds(glideSeconds(v)) },
  { key: "level", label: "Level", format: fmtPercent },
];

type FxKey = Exclude<keyof FxSettings, "delayDiv">;
export const FX_KNOBS: KnobSpec<FxKey>[] = [
  { key: "comp", label: "Compressor", format: fmtPercent },
  { key: "delayFb", label: "Delay feedback", format: (v) => fmtPercent(feedbackGain(v) * 100) },
  { key: "delayMix", label: "Delay mix", format: fmtPercent },
  { key: "reverbSize", label: "Reverb size", format: (v) => fmtSeconds(reverbSeconds(v)) },
  { key: "reverbMix", label: "Reverb mix", format: fmtPercent },
  { key: "master", label: "Master", format: fmtPercent },
];

export const delayDivisionLabel = (i: number): string => DELAY_DIVISIONS[i]?.label ?? "?";

export const trackName = (track: number, labels: Record<string, string>): string => (track === SYNTH_TRACK ? "Synth" : (labels[DRUM_IDS[track]] ?? `Track ${track + 1}`));

export interface KeyInfo {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** Tag name and input type of the focused element, if any. */
  targetTag?: string;
  targetType?: string;
}

export type KeyAction =
  | { type: "toggle-play" }
  | { type: "select-track"; track: number }
  | { type: "mute" }
  | { type: "solo" }
  | { type: "tempo"; delta: number }
  | { type: "pattern"; delta: number };

/** True when the keystroke is going into a text field, where shortcuts must not fire. */
export function isTypingTarget(tag?: string, type?: string): boolean {
  const t = tag?.toUpperCase();
  if (t === "TEXTAREA" || t === "SELECT") return true;
  return t === "INPUT" && !["range", "checkbox", "radio", "button"].includes((type ?? "text").toLowerCase());
}

/**
 * Keyboard shortcuts: Space plays and stops, 1-8 select a drum track (9 the
 * synth), M and S mute and solo the selected track, Up/Down nudge the tempo
 * (Shift for 10), [ and ] change pattern slot.
 */
export function keyAction(e: KeyInfo): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.targetTag, e.targetType)) return null;
  const k = e.key;
  if (k === " " || k === "Spacebar") return { type: "toggle-play" };
  if (/^[1-9]$/.test(k)) {
    const track = Number(k) - 1;
    return track < TRACK_COUNT ? { type: "select-track", track } : null;
  }
  switch (k.toLowerCase()) {
    case "m":
      return { type: "mute" };
    case "s":
      return { type: "solo" };
    case "arrowup":
      return { type: "tempo", delta: e.shiftKey ? 10 : 1 };
    case "arrowdown":
      return { type: "tempo", delta: e.shiftKey ? -10 : -1 };
    case "]":
      return { type: "pattern", delta: 1 };
    case "[":
      return { type: "pattern", delta: -1 };
    default:
      return null;
  }
}

export const TEMPO_RANGE = { min: MIN_TEMPO, max: MAX_TEMPO };
export const SWING_RANGE = { min: 0, max: MAX_SWING };

/** Wrap a pattern slot index, so "next" after D is A. */
export const wrapSlot = (slot: number): number => ((slot % PATTERN_COUNT) + PATTERN_COUNT) % PATTERN_COUNT;

/** Hue (degrees) used to colour each track's row. */
export const TRACK_HUES = [14, 34, 52, 74, 160, 190, 262, 320, 205];

/** Pixels of vertical drag per semitone on a synth step. */
export const DRAG_PIXELS_PER_NOTE = 7;

export const noteFromDrag = (startNote: number, startY: number, y: number): number => Math.min(127, Math.max(0, startNote + Math.round((startY - y) / DRAG_PIXELS_PER_NOTE)));

