import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/presets";
import { BEATS_PER_BAR, planSong, renderBeat, renderWav } from "../src/render";
import { stepDuration } from "../src/scheduler";
import { Sequencer } from "../src/sequencer";
import { createDefaultState } from "../src/state";
import { MockBuffer, MockContext, MockOscillator } from "./mock-audio";

class MockOffline extends MockContext {
  constructor(
    public channels: number,
    public length: number,
    sr: number,
  ) {
    super();
    this.sampleRate = sr;
  }
  async startRendering() {
    const b = new MockBuffer(this.channels, this.length, this.sampleRate);
    b.getChannelData(0).fill(0.5);
    b.getChannelData(1).fill(-2);
    return b;
  }
}

describe("planSong", () => {
  it("lays out 4 bars of 4/4: 64 sixteenth steps at the right times", () => {
    const s = createDefaultState();
    s.tempo = 120;
    const { steps, seconds } = planSong(s, 4);
    expect(steps).toHaveLength(64);
    expect(seconds).toBeCloseTo(8); // 16 beats at 120 BPM
    expect(seconds).toBeCloseTo(4 * BEATS_PER_BAR * (60 / 120));
    steps.forEach((st, i) => expect(st.time).toBeCloseTo(i * 0.125, 9));
  });
  it.each([60, 90, 140, 200])("lasts 16 beats at %i BPM", (tempo) => {
    const s = createDefaultState();
    s.tempo = tempo;
    expect(planSong(s, 4).seconds).toBeCloseTo((16 * 60) / tempo);
  });
  it("swings only off-beats", () => {
    const s = createDefaultState();
    s.tempo = 120;
    s.swing = 50;
    const { steps } = planSong(s, 1);
    steps.forEach((st, i) => expect(st.time - i * 0.125).toBeCloseTo(i % 2 ? 0.5 * stepDuration(120) : 0, 9));
  });
  it("loops short patterns and walks the chain", () => {
    const s = createDefaultState();
    s.patterns[0].length = 8;
    s.patterns[1].length = 8;
    s.chain = [0, 1];
    s.chainMode = true;
    const { steps } = planSong(s, 1);
    expect(steps.map((x) => x.step)).toEqual([...Array(8).keys(), ...Array(8).keys()]);
    expect(steps.map((x) => x.pattern)).toEqual([...Array(8).fill(0), ...Array(8).fill(1)]);
  });
  it("loops a single pattern when not chaining", () => {
    const s = createDefaultState();
    s.current = 2;
    expect(new Set(planSong(s, 2).steps.map((x) => x.pattern))).toEqual(new Set([2]));
  });
  it("includes the sounds for each step and honours mute", () => {
    const s = createDefaultState();
    s.patterns[0].drums[0][0] = { on: true, vel: 12, accent: false };
    s.patterns[0].drums[1][0] = { on: true, vel: 12, accent: false };
    s.tracks[1].mute = true;
    const first = planSong(s, 1).steps[0];
    expect(first.events.map((e) => e.drum)).toEqual(["kick"]);
  });
  it("does not change the state it is given", () => {
    const s = structuredClone(PRESETS[3].state);
    planSong(s, 4);
    expect(s).toEqual(PRESETS[3].state);
    expect(new Sequencer(s).playPattern).toBe(0);
  });
});

describe("renderBeat", () => {
  const make = () => {
    const made: MockOffline[] = [];
    const createContext = (ch: number, len: number, sr: number) => {
      const c = new MockOffline(ch, len, sr);
      made.push(c);
      return c as unknown as OfflineAudioContext;
    };
    return { made, createContext };
  };

  it("renders stereo at the requested length including the tail", async () => {
    const { made, createContext } = make();
    const s = createDefaultState();
    s.tempo = 120;
    const r = await renderBeat(s, { createContext, sampleRate: 8000, tail: 1 });
    expect(made[0].channels).toBe(2);
    expect(made[0].length).toBe(9 * 8000); // 8 s of bars + 1 s tail
    expect(r.channels).toHaveLength(2);
    expect(r.sampleRate).toBe(8000);
    expect(r.seconds).toBe(9);
    expect(r.channels[0][0]).toBe(0.5);
  });
  it("defaults to 4 bars, a 1.5 s tail and 44.1 kHz", async () => {
    const { made, createContext } = make();
    const s = createDefaultState();
    s.tempo = 100;
    await renderBeat(s, { createContext });
    expect(made[0].sampleRate).toBe(44100);
    expect(made[0].length).toBe(Math.ceil((9.6 + 1.5) * 44100));
  });
  it("schedules every sound at its planned time", async () => {
    const { made, createContext } = make();
    const s = createDefaultState();
    s.tempo = 120;
    s.patterns[0].drums[0][0] = { on: true, vel: 12, accent: false };
    s.patterns[0].drums[0][4] = { on: true, vel: 12, accent: false };
    await renderBeat(s, { createContext, bars: 1 });
    const kicks = made[0].all<MockOscillator>("oscillator").map((o) => o.startedAt);
    expect(kicks).toHaveLength(2);
    expect(kicks[0]).toBe(0);
    expect(kicks[1]).toBeCloseTo(0.5);
  });
  it("includes synth notes", async () => {
    const { made, createContext } = make();
    const s = createDefaultState();
    s.patterns[0].synth[2] = { on: true, vel: 12, accent: false, note: 60 };
    await renderBeat(s, { createContext, bars: 1 });
    expect(made[0].all("oscillator")).toHaveLength(1);
  });
  it("encodes a valid WAV of the right length and clamps hot samples", async () => {
    const { createContext } = make();
    const s = createDefaultState();
    s.tempo = 120;
    const wav = await renderWav(s, { createContext, sampleRate: 8000, tail: 0, bars: 1 });
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    const frames = 2 * 8000;
    expect(v.getUint32(40, true)).toBe(frames * 4);
    expect(v.getInt16(44, true)).toBe(16384); // 0.5 on the left
    expect(v.getInt16(46, true)).toBe(-32768); // -2 clamped on the right
  });
  it("falls back to a real OfflineAudioContext when none is injected", async () => {
    (globalThis as Record<string, unknown>).OfflineAudioContext = MockOffline;
    try {
      const r = await renderBeat(createDefaultState(), { bars: 1, tail: 0, sampleRate: 8000 });
      expect(r.sampleRate).toBe(8000);
    } finally {
      delete (globalThis as Record<string, unknown>).OfflineAudioContext;
    }
  });
});
