import { describe, expect, it } from "vitest";
import {
  AudioUnsupportedError,
  Rng,
  clamp,
  createAudioContext,
  createNoiseBuffer,
  dbToGain,
  ensureRunning,
  gainToDb,
  getAudioContextCtor,
  knobExp,
  knobLinear,
  midiToFreq,
  midiToName,
  noiseSamples,
} from "../src/audio-context";
import { MockContext, asCtx } from "./mock-audio";

describe("getAudioContextCtor", () => {
  it("prefers AudioContext", () => {
    class A {}
    class W {}
    expect(getAudioContextCtor({ AudioContext: A, webkitAudioContext: W })).toBe(A);
  });
  it("falls back to webkitAudioContext", () => {
    class W {}
    expect(getAudioContextCtor({ webkitAudioContext: W })).toBe(W);
  });
  it("throws a clear error when Web Audio is missing", () => {
    expect(() => getAudioContextCtor({})).toThrow(AudioUnsupportedError);
    expect(() => getAudioContextCtor({})).toThrow(/no Web Audio/);
  });
});

describe("createAudioContext", () => {
  it("asks for interactive latency and optionally a sample rate", () => {
    const seen: AudioContextOptions[] = [];
    class Fake {
      constructor(o?: AudioContextOptions) {
        seen.push(o ?? {});
      }
    }
    createAudioContext({ scope: { AudioContext: Fake } });
    createAudioContext({ scope: { AudioContext: Fake }, sampleRate: 48000 });
    expect(seen[0]).toEqual({ latencyHint: "interactive" });
    expect(seen[1]).toEqual({ latencyHint: "interactive", sampleRate: 48000 });
  });
});

describe("ensureRunning", () => {
  it("resumes a suspended context", async () => {
    const ctx = new MockContext();
    ctx.state = "suspended";
    expect(await ensureRunning(ctx as unknown as AudioContext)).toBe(true);
    expect(ctx.resumeCalls).toBe(1);
  });
  it("does nothing when already running", async () => {
    const ctx = new MockContext();
    expect(await ensureRunning(ctx as unknown as AudioContext)).toBe(true);
    expect(ctx.resumeCalls).toBe(0);
  });
  it("reports false for a closed context", async () => {
    const ctx = new MockContext();
    ctx.state = "closed";
    expect(await ensureRunning(ctx as unknown as AudioContext)).toBe(false);
  });
  it("reports false when resume() rejects", async () => {
    const ctx = { state: "suspended", resume: () => Promise.reject(new Error("blocked")) };
    expect(await ensureRunning(ctx as unknown as AudioContext)).toBe(false);
  });
  it("reports false when the context stays suspended", async () => {
    const ctx = { state: "suspended", resume: async () => {} };
    expect(await ensureRunning(ctx as unknown as AudioContext)).toBe(false);
  });
});

describe("audio math", () => {
  it("clamps", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
  it("maps knobs linearly and exponentially, clamping out-of-range knobs", () => {
    expect(knobLinear(0, 10, 20)).toBe(10);
    expect(knobLinear(50, 10, 20)).toBe(15);
    expect(knobLinear(200, 10, 20)).toBe(20);
    expect(knobExp(0, 20, 20000)).toBeCloseTo(20);
    expect(knobExp(100, 20, 20000)).toBeCloseTo(20000);
    expect(knobExp(50, 20, 20000)).toBeCloseTo(Math.sqrt(20 * 20000));
    expect(knobExp(-10, 20, 20000)).toBeCloseTo(20);
  });
  it("converts dB and gain both ways", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12);
    expect(gainToDb(0)).toBeLessThan(-100);
  });
  it("converts MIDI to Hz and names", () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(57)).toBeCloseTo(220);
    expect(midiToFreq(60)).toBeCloseTo(261.626, 2);
    expect(midiToName(60)).toBe("C4");
    expect(midiToName(69)).toBe("A4");
    expect(midiToName(37)).toBe("C#2");
  });
});

describe("noise", () => {
  it("is deterministic per seed and differs between seeds", () => {
    expect(noiseSamples(64, 7)).toEqual(noiseSamples(64, 7));
    expect(noiseSamples(64, 7)).not.toEqual(noiseSamples(64, 8));
  });
  it("stays in [-1, 1] with a mean near zero", () => {
    const n = noiseSamples(20000, 1);
    let sum = 0;
    for (const v of n) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(Math.abs(sum / n.length)).toBeLessThan(0.03);
  });
  it("Rng survives a zero seed", () => {
    const r = new Rng(0);
    expect(r.next()).toBeGreaterThan(0);
  });
  it("fills a context buffer", () => {
    const ctx = new MockContext();
    ctx.sampleRate = 8000;
    const buf = createNoiseBuffer(asCtx(ctx), 0.5, 3);
    expect(buf.length).toBe(4000);
    expect(buf.numberOfChannels).toBe(1);
    expect(buf.getChannelData(0)).toEqual(noiseSamples(4000, 3));
  });
});
