import { describe, expect, it, vi } from "vitest";
import { ACCENT_BOOST, Sequencer, velocityGain } from "../src/sequencer";
import { NOTE_DEFAULT, SYNTH_TRACK, VEL_DEFAULT, createDefaultState, type BeatState } from "../src/state";

const make = (edit?: (s: BeatState) => void) => {
  const s = createDefaultState();
  edit?.(s);
  return new Sequencer(s);
};

describe("step and note toggling", () => {
  it("toggles a drum step on and off", () => {
    const q = make();
    expect(q.toggleStep(0, 4)).toBe(true);
    expect(q.pattern.drums[0][4].on).toBe(true);
    expect(q.toggleStep(0, 4)).toBe(false);
    expect(q.pattern.drums[0][4].on).toBe(false);
  });
  it("only touches the one step", () => {
    const q = make();
    q.toggleStep(2, 7);
    const on = q.pattern.drums.flat().filter((s) => s.on);
    expect(on).toHaveLength(1);
  });
  it("turning a step off resets its velocity and accent", () => {
    const q = make();
    q.toggleStep(1, 0);
    q.setVelocity(1, 0, 5);
    q.toggleAccent(1, 0);
    q.toggleStep(1, 0);
    expect(q.pattern.drums[1][0]).toEqual({ on: false, vel: VEL_DEFAULT, accent: false });
  });
  it("toggles synth steps and resets the note when they go off", () => {
    const q = make();
    q.toggleStep(SYNTH_TRACK, 3);
    q.setNote(3, 60);
    expect(q.pattern.synth[3]).toMatchObject({ on: true, note: 60 });
    q.toggleStep(SYNTH_TRACK, 3);
    expect(q.pattern.synth[3]).toMatchObject({ on: false, note: NOTE_DEFAULT });
  });
  it("sets and clamps notes, switching the step on", () => {
    const q = make();
    q.setNote(0, 200);
    expect(q.pattern.synth[0]).toMatchObject({ on: true, note: 127 });
    q.setNote(0, -4);
    expect(q.pattern.synth[0].note).toBe(0);
    q.setNote(0, 60.4);
    expect(q.pattern.synth[0].note).toBe(60);
  });
  it("transposes by semitones", () => {
    const q = make();
    q.setNote(2, 48);
    q.transposeStep(2, 7);
    q.transposeStep(2, -2);
    expect(q.pattern.synth[2].note).toBe(53);
  });
  it("rejects bad track and step indexes", () => {
    const q = make();
    expect(() => q.toggleStep(9, 0)).toThrow(RangeError);
    expect(() => q.toggleStep(-1, 0)).toThrow(RangeError);
    expect(() => q.toggleStep(0, 32)).toThrow(RangeError);
    expect(() => q.toggleStep(0, 1.5)).toThrow(RangeError);
    expect(() => q.setNote(40, 60)).toThrow(RangeError);
    expect(() => q.transposeStep(40, 1)).toThrow(RangeError);
  });
  it("clears a track", () => {
    const q = make();
    [0, 4, 8].forEach((i) => q.toggleStep(3, i));
    q.setVelocity(3, 4, 2);
    q.clearTrack(3);
    expect(q.pattern.drums[3].every((s) => !s.on && s.vel === VEL_DEFAULT)).toBe(true);
    expect(() => q.clearTrack(12)).toThrow(RangeError);
  });
});

describe("velocity and accent", () => {
  it("sets velocity, rounds and clamps it, and turns the step on", () => {
    const q = make();
    q.setVelocity(0, 0, 8);
    expect(q.pattern.drums[0][0]).toMatchObject({ on: true, vel: 8 });
    q.setVelocity(0, 0, 99);
    expect(q.pattern.drums[0][0].vel).toBe(16);
    q.setVelocity(0, 0, -3);
    expect(q.pattern.drums[0][0].vel).toBe(1);
    q.setVelocity(0, 0, 7.6);
    expect(q.pattern.drums[0][0].vel).toBe(8);
  });
  it("toggles accent", () => {
    const q = make();
    expect(q.toggleAccent(2, 4)).toBe(true);
    expect(q.pattern.drums[2][4]).toMatchObject({ on: true, accent: true });
    expect(q.toggleAccent(2, 4)).toBe(false);
  });
  it("maps velocity and accent to gain", () => {
    expect(velocityGain(16, false)).toBe(1);
    expect(velocityGain(16, true)).toBeCloseTo(ACCENT_BOOST);
    expect(velocityGain(8, false)).toBeCloseTo(Math.pow(0.5, 1.5));
    expect(velocityGain(4, false)).toBeLessThan(velocityGain(12, false));
    expect(velocityGain(0, false)).toBe(velocityGain(1, false));
    expect(velocityGain(99, false)).toBe(1);
  });
  it("turns steps into trigger events with their gains", () => {
    const q = make();
    q.setVelocity(0, 0, 8);
    q.toggleAccent(1, 0);
    const ev = q.eventsAt(0);
    expect(ev.map((e) => e.drum)).toEqual(["kick", "snare"]);
    expect(ev[0].gain).toBeCloseTo(velocityGain(8, false));
    expect(ev[1]).toMatchObject({ accent: true });
    expect(ev[1].gain).toBeCloseTo(velocityGain(VEL_DEFAULT, true));
  });
  it("includes the synth note in events", () => {
    const q = make();
    q.setNote(5, 55);
    expect(q.eventsAt(5)).toEqual([{ track: SYNTH_TRACK, note: 55, gain: velocityGain(VEL_DEFAULT, false), accent: false }]);
  });
  it("has no events for empty steps or steps past the pattern length", () => {
    const q = make();
    expect(q.eventsAt(3)).toEqual([]);
    q.setLength(8);
    q.toggleStep(0, 12);
    expect(q.eventsAt(12)).toEqual([]);
    expect(q.eventsAt(-1)).toEqual([]);
  });
});

describe("mute and solo", () => {
  it("everything is audible by default", () => {
    const q = make();
    for (let t = 0; t < 9; t++) expect(q.isAudible(t)).toBe(true);
  });
  it("mute silences just that track", () => {
    const q = make();
    expect(q.toggleMute(2)).toBe(true);
    expect(q.isAudible(2)).toBe(false);
    expect(q.isAudible(1)).toBe(true);
    expect(q.toggleMute(2)).toBe(false);
    expect(q.isAudible(2)).toBe(true);
  });
  it("solo silences everything else", () => {
    const q = make();
    q.toggleSolo(1);
    expect(q.anySolo).toBe(true);
    expect(q.isAudible(1)).toBe(true);
    expect(q.isAudible(0)).toBe(false);
    expect(q.isAudible(SYNTH_TRACK)).toBe(false);
  });
  it("several solos play together, and un-soloing restores the mix", () => {
    const q = make();
    q.toggleSolo(0);
    q.toggleSolo(SYNTH_TRACK);
    expect([0, 1, SYNTH_TRACK].map((t) => q.isAudible(t))).toEqual([true, false, true]);
    q.toggleSolo(0);
    q.toggleSolo(SYNTH_TRACK);
    expect(q.anySolo).toBe(false);
    expect(q.isAudible(1)).toBe(true);
  });
  it("solo wins over mute on the same track", () => {
    const q = make();
    q.toggleMute(3);
    q.toggleSolo(3);
    expect(q.isAudible(3)).toBe(true);
  });
  it("muted and non-soloed tracks produce no events", () => {
    const q = make();
    q.toggleStep(0, 0);
    q.toggleStep(1, 0);
    q.toggleStep(SYNTH_TRACK, 0);
    q.toggleMute(0);
    expect(q.eventsAt(0).map((e) => e.track)).toEqual([1, SYNTH_TRACK]);
    q.toggleSolo(SYNTH_TRACK);
    expect(q.eventsAt(0).map((e) => e.track)).toEqual([SYNTH_TRACK]);
  });
  it("rejects bad track numbers", () => {
    expect(() => make().toggleMute(9)).toThrow(RangeError);
    expect(() => make().isAudible(-1)).toThrow(RangeError);
  });
});

describe("pattern length and slots", () => {
  it("sets length to 8, 16 or 32 only", () => {
    const q = make();
    for (const l of [8, 32, 16]) {
      q.setLength(l);
      expect(q.pattern.length).toBe(l);
    }
    expect(() => q.setLength(12)).toThrow(/8, 16 or 32/);
  });
  it("sets the length of another slot", () => {
    const q = make();
    q.setLength(8, 2);
    expect(q.state.patterns[2].length).toBe(8);
    expect(q.pattern.length).toBe(16);
  });
  it("selects slots", () => {
    const q = make();
    q.selectPattern(2);
    expect(q.state.current).toBe(2);
    expect(q.pattern).toBe(q.state.patterns[2]);
    expect(() => q.selectPattern(4)).toThrow(RangeError);
  });
  it("copies a pattern deeply", () => {
    const q = make();
    q.toggleStep(0, 0);
    q.setVelocity(1, 3, 6);
    q.setNote(2, 60);
    q.setLength(32);
    q.copyPattern(0, 2);
    expect(q.state.patterns[2]).toEqual(q.state.patterns[0]);
    expect(q.state.patterns[2]).not.toBe(q.state.patterns[0]);
    q.selectPattern(2);
    q.toggleStep(0, 0);
    expect(q.state.patterns[0].drums[0][0].on).toBe(true);
    expect(q.state.patterns[2].drums[0][0].on).toBe(false);
  });
  it("copy onto itself is a no-op and bad slots throw", () => {
    const q = make();
    const fn = vi.fn();
    q.subscribe(fn);
    q.copyPattern(1, 1);
    expect(fn).not.toHaveBeenCalled();
    expect(() => q.copyPattern(0, 4)).toThrow(RangeError);
    expect(() => q.copyPattern(-1, 0)).toThrow(RangeError);
  });
  it("clears a slot but keeps its length", () => {
    const q = make();
    q.setLength(32);
    q.toggleStep(0, 31);
    q.clearPattern(0);
    expect(q.pattern.drums[0][31].on).toBe(false);
    expect(q.pattern.length).toBe(32);
    expect(() => q.clearPattern(9)).toThrow(RangeError);
  });
});

describe("chain order", () => {
  const chained = (slots: number[]) =>
    make((s) => {
      s.chain = slots;
      s.chainMode = true;
    });
  const walk = (q: Sequencer, n: number) => {
    const seq = [q.playPattern];
    for (let i = 1; i < n; i++) seq.push(q.advance());
    return seq;
  };

  it("plays the chain in order and loops", () => {
    const q = chained([0, 2, 1]);
    q.start();
    expect(walk(q, 7)).toEqual([0, 2, 1, 0, 2, 1, 0]);
  });
  it("allows repeats", () => {
    const q = chained([0, 0, 3]);
    q.start();
    expect(walk(q, 6)).toEqual([0, 0, 3, 0, 0, 3]);
  });
  it("starts from the first chain slot, not the selected one", () => {
    const q = chained([3, 1]);
    q.selectPattern(2);
    q.start();
    expect(q.playPattern).toBe(3);
  });
  it("loops the selected pattern when chain mode is off", () => {
    const q = make((s) => {
      s.chain = [0, 1];
      s.current = 2;
    });
    q.start();
    expect(walk(q, 3)).toEqual([2, 2, 2]);
  });
  it("falls back to the selected pattern when the chain is empty", () => {
    const q = make((s) => {
      s.chainMode = true;
      s.current = 1;
    });
    q.start();
    expect(walk(q, 3)).toEqual([1, 1, 1]);
  });
  it("restarts the chain on start()", () => {
    const q = chained([0, 1, 2]);
    q.start();
    q.advance();
    q.advance();
    q.start();
    expect(q.playPattern).toBe(0);
    expect(q.advance()).toBe(1);
  });
  it("switches to a newly selected pattern at the next loop when not chaining", () => {
    const q = make();
    q.start();
    q.selectPattern(3);
    expect(q.playPattern).toBe(0);
    q.advance();
    expect(q.playPattern).toBe(3);
  });
  it("plays steps from the pattern that is playing", () => {
    const q = chained([0, 1]);
    q.toggleStep(0, 0);
    q.selectPattern(1);
    q.toggleStep(1, 0);
    q.start();
    expect(q.eventsAt(0).map((e) => e.drum)).toEqual(["kick"]);
    q.advance();
    expect(q.eventsAt(0).map((e) => e.drum)).toEqual(["snare"]);
    expect(q.playLength).toBe(16);
    q.setLength(8, 1);
    expect(q.playLength).toBe(8);
  });
  it("edits the chain", () => {
    const q = make();
    expect(q.appendChain(1)).toBe(true);
    q.appendChain(3);
    expect(q.state.chain).toEqual([1, 3]);
    q.popChain();
    expect(q.state.chain).toEqual([1]);
    q.clearChain();
    expect(q.state.chain).toEqual([]);
    q.setChain([2, 2, 0]);
    expect(q.state.chain).toEqual([2, 2, 0]);
    q.setChainMode(true);
    expect(q.state.chainMode).toBe(true);
  });
  it("caps the chain at 8 and validates slots", () => {
    const q = make();
    for (let i = 0; i < 8; i++) expect(q.appendChain(i % 4)).toBe(true);
    expect(q.appendChain(0)).toBe(false);
    expect(() => q.setChain([0, 1, 2, 3, 0, 1, 2, 3, 0])).toThrow(/at most 8/);
    expect(() => q.setChain([5])).toThrow(RangeError);
    expect(() => q.appendChain(7)).toThrow(RangeError);
  });
});

describe("parameters", () => {
  it("clamps and rounds tempo and swing", () => {
    const q = make();
    q.setTempo(500);
    expect(q.state.tempo).toBe(200);
    q.setTempo(10);
    expect(q.state.tempo).toBe(60);
    q.setTempo(120.4);
    expect(q.state.tempo).toBe(120);
    q.setSwing(90);
    expect(q.state.swing).toBe(75);
    q.setSwing(-4);
    expect(q.state.swing).toBe(0);
  });
  it("sets drum, synth and fx knobs within range", () => {
    const q = make();
    q.setDrumParam(0, "tune", 130);
    expect(q.state.tracks[0].tune).toBe(100);
    q.setDrumParam(3, "decay", 12.6);
    expect(q.state.tracks[3].decay).toBe(13);
    expect(() => q.setDrumParam(8, "level", 5)).toThrow(RangeError);
    expect(() => q.setDrumParam(-1, "level", 5)).toThrow(RangeError);
    q.setSynthParam("wave", 9);
    expect(q.state.synth.wave).toBe(3);
    q.setSynthParam("cutoff", -3);
    expect(q.state.synth.cutoff).toBe(0);
    q.setFx("delayDiv", 99);
    expect(q.state.fx.delayDiv).toBe(5);
    q.setFx("reverbMix", 40);
    expect(q.state.fx.reverbMix).toBe(40);
  });
});

describe("notifications and loading", () => {
  it("notifies subscribers on every change until they unsubscribe", () => {
    const q = make();
    const fn = vi.fn();
    const off = q.subscribe(fn);
    q.toggleStep(0, 0);
    q.setTempo(90);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    q.setTempo(91);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("loads a valid state as a copy and resets playback", () => {
    const q = make();
    const next = createDefaultState();
    next.tempo = 140;
    next.current = 2;
    const fn = vi.fn();
    q.subscribe(fn);
    q.load(next);
    expect(q.state.tempo).toBe(140);
    expect(q.state).not.toBe(next);
    expect(q.playPattern).toBe(2);
    expect(fn).toHaveBeenCalled();
  });
  it("refuses an invalid state and keeps the old one", () => {
    const q = make();
    const bad = createDefaultState();
    bad.tempo = 5;
    expect(() => q.load(bad)).toThrow(/Invalid beat/);
    expect(q.state.tempo).toBe(100);
    expect(() => new Sequencer(bad)).toThrow(/Invalid beat/);
  });
});
