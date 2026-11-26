import { describe, expect, it } from "vitest";
import {
  DRAG_PIXELS_PER_NOTE,
  DRUM_KNOBS,
  FX_KNOBS,
  SLOT_NAMES,
  SYNTH_KNOBS,
  TRACK_HUES,
  VELOCITY_LEVELS,
  delayDivisionLabel,
  fmtHz,
  fmtPercent,
  fmtSeconds,
  fmtSigned,
  isTypingTarget,
  keyAction,
  nextVelocity,
  noteFromDrag,
  trackName,
  wrapSlot,
} from "../src/controls";
import { DRUM_LABELS } from "../src/drums";
import { TRACK_COUNT } from "../src/state";

describe("nextVelocity", () => {
  it("cycles 4 -> 8 -> 12 -> 16 -> 4", () => {
    expect(VELOCITY_LEVELS).toEqual([4, 8, 12, 16]);
    expect(nextVelocity(4)).toBe(8);
    expect(nextVelocity(8)).toBe(12);
    expect(nextVelocity(12)).toBe(16);
    expect(nextVelocity(16)).toBe(4);
  });
  it("rounds up from values between levels", () => {
    expect(nextVelocity(1)).toBe(4);
    expect(nextVelocity(9)).toBe(12);
    expect(nextVelocity(14)).toBe(16);
  });
});

describe("keyAction", () => {
  it("space toggles play", () => {
    expect(keyAction({ key: " " })).toEqual({ type: "toggle-play" });
    expect(keyAction({ key: "Spacebar" })).toEqual({ type: "toggle-play" });
  });
  it("1-8 select drum tracks and 9 the synth", () => {
    for (let n = 1; n <= 8; n++) expect(keyAction({ key: String(n) })).toEqual({ type: "select-track", track: n - 1 });
    expect(keyAction({ key: "9" })).toEqual({ type: "select-track", track: 8 });
    expect(TRACK_COUNT).toBe(9);
  });
  it("0 does nothing", () => {
    expect(keyAction({ key: "0" })).toBeNull();
  });
  it("m, s, tempo and pattern keys", () => {
    expect(keyAction({ key: "m" })).toEqual({ type: "mute" });
    expect(keyAction({ key: "S" })).toEqual({ type: "solo" });
    expect(keyAction({ key: "ArrowUp" })).toEqual({ type: "tempo", delta: 1 });
    expect(keyAction({ key: "ArrowDown", shiftKey: true })).toEqual({ type: "tempo", delta: -10 });
    expect(keyAction({ key: "ArrowUp", shiftKey: true })).toEqual({ type: "tempo", delta: 10 });
    expect(keyAction({ key: "ArrowDown" })).toEqual({ type: "tempo", delta: -1 });
    expect(keyAction({ key: "]" })).toEqual({ type: "pattern", delta: 1 });
    expect(keyAction({ key: "[" })).toEqual({ type: "pattern", delta: -1 });
  });
  it("ignores unknown keys and browser shortcuts", () => {
    expect(keyAction({ key: "x" })).toBeNull();
    expect(keyAction({ key: "1", ctrlKey: true })).toBeNull();
    expect(keyAction({ key: " ", metaKey: true })).toBeNull();
    expect(keyAction({ key: "m", altKey: true })).toBeNull();
  });
  it("stays out of the way while typing", () => {
    expect(keyAction({ key: " ", targetTag: "INPUT", targetType: "text" })).toBeNull();
    expect(keyAction({ key: "1", targetTag: "textarea" })).toBeNull();
    expect(keyAction({ key: "m", targetTag: "SELECT" })).toBeNull();
    expect(keyAction({ key: " ", targetTag: "INPUT", targetType: "range" })).toEqual({ type: "toggle-play" });
    expect(keyAction({ key: " ", targetTag: "BUTTON" })).toEqual({ type: "toggle-play" });
  });
  it("isTypingTarget distinguishes inputs", () => {
    expect(isTypingTarget("INPUT")).toBe(true);
    expect(isTypingTarget("input", "number")).toBe(true);
    expect(isTypingTarget("input", "checkbox")).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});

describe("formatting", () => {
  it("formats time, frequency, percent and signed values", () => {
    expect(fmtSeconds(0.12)).toBe("120 ms");
    expect(fmtSeconds(1.5)).toBe("1.50 s");
    expect(fmtSeconds(12)).toBe("12.0 s");
    expect(fmtHz(440)).toBe("440 Hz");
    expect(fmtHz(1200)).toBe("1.20 kHz");
    expect(fmtHz(14000)).toBe("14.0 kHz");
    expect(fmtPercent(49.6)).toBe("50%");
    expect(fmtSigned(3, "st")).toBe("+3 st");
    expect(fmtSigned(-12, "st")).toBe("-12 st");
    expect(fmtSigned(0, "st")).toBe("0 st");
    expect(fmtSigned(1.5, "x")).toBe("+1.5 x");
  });
  it("every knob formats its whole range without throwing", () => {
    for (const k of [...DRUM_KNOBS, ...SYNTH_KNOBS, ...FX_KNOBS]) {
      expect(k.label).toBeTruthy();
      for (const v of [0, 50, 100]) expect(k.format(v)).toMatch(/\S/);
    }
  });
  it("reads out musical values", () => {
    const tune = DRUM_KNOBS.find((k) => k.key === "tune")!;
    expect(tune.format(50)).toBe("0 st");
    expect(tune.format(100)).toBe("+12 st");
    expect(tune.format(0)).toBe("-12 st");
    expect(SYNTH_KNOBS.find((k) => k.key === "cutoff")!.format(100)).toBe("14.0 kHz");
    expect(SYNTH_KNOBS.find((k) => k.key === "attack")!.format(0)).toBe("1 ms");
  });
  it("labels delay divisions and tracks", () => {
    expect(delayDivisionLabel(3)).toBe("1/4");
    expect(delayDivisionLabel(99)).toBe("?");
    expect(trackName(0, DRUM_LABELS)).toBe("Kick");
    expect(trackName(8, DRUM_LABELS)).toBe("Synth");
    expect(trackName(7, {})).toBe("Track 8");
  });
});

describe("misc helpers", () => {
  it("names the four slots and wraps them", () => {
    expect(SLOT_NAMES).toEqual(["A", "B", "C", "D"]);
    expect(wrapSlot(4)).toBe(0);
    expect(wrapSlot(-1)).toBe(3);
    expect(wrapSlot(2)).toBe(2);
  });
  it("has a hue per track", () => {
    expect(TRACK_HUES).toHaveLength(TRACK_COUNT);
  });
  it("turns a vertical drag into a note change, clamped to MIDI range", () => {
    expect(noteFromDrag(48, 100, 100)).toBe(48);
    expect(noteFromDrag(48, 100, 100 - 3 * DRAG_PIXELS_PER_NOTE)).toBe(51);
    expect(noteFromDrag(48, 100, 100 + 2 * DRAG_PIXELS_PER_NOTE)).toBe(46);
    expect(noteFromDrag(120, 100, -500)).toBe(127);
    expect(noteFromDrag(3, 100, 900)).toBe(0);
  });
});
