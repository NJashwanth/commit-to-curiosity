import { describe, expect, it } from "vitest";
import {
  Effects,
  MAX_FEEDBACK,
  compressorSettings,
  createReverbBuffer,
  delayTimeSeconds,
  feedbackGain,
  generateImpulseResponse,
  masterGain,
  reverbSeconds,
  wetGain,
} from "../src/effects";
import { FX_DEFAULTS, createDefaultState, type FxSettings } from "../src/state";
import {
  MockAnalyser,
  MockBiquad,
  MockCompressor,
  MockContext,
  MockConvolver,
  MockDelay,
  MockGain,
  MockNode,
  asCtx,
} from "./mock-audio";

describe("delay time sync", () => {
  it("is a note length at the tempo", () => {
    expect(delayTimeSeconds(120, 3)).toBeCloseTo(0.5); // 1/4 at 120 BPM
    expect(delayTimeSeconds(120, 1)).toBeCloseTo(0.25); // 1/8
    expect(delayTimeSeconds(120, 2)).toBeCloseTo(0.375); // dotted 1/8
    expect(delayTimeSeconds(60, 5)).toBeCloseTo(2); // 1/2 at 60 BPM
    expect(delayTimeSeconds(200, 0)).toBeCloseTo(0.075); // 1/16 at 200 BPM
  });
  it("scales inversely with tempo", () => {
    expect(delayTimeSeconds(60, 3)).toBeCloseTo(2 * delayTimeSeconds(120, 3));
  });
  it("clamps a bad division index", () => {
    expect(delayTimeSeconds(120, 99)).toBe(delayTimeSeconds(120, 5));
    expect(delayTimeSeconds(120, -3)).toBe(delayTimeSeconds(120, 0));
  });
  it("never exceeds the 4 s delay buffer at the slowest tempo", () => {
    expect(delayTimeSeconds(60, 5)).toBeLessThan(4);
  });
});

describe("parameter mapping", () => {
  it("compressor gets harder with the knob", () => {
    const soft = compressorSettings(0);
    const hard = compressorSettings(100);
    expect(soft.threshold).toBe(-10);
    expect(hard.threshold).toBe(-32);
    expect(soft.ratio).toBe(2);
    expect(hard.ratio).toBe(12);
    expect(soft.attack).toBeGreaterThan(0);
  });
  it("feedback stays below 1 so the delay always dies away", () => {
    expect(feedbackGain(100)).toBe(MAX_FEEDBACK);
    expect(feedbackGain(100)).toBeLessThan(1);
    expect(feedbackGain(0)).toBe(0);
  });
  it("maps wet, master and reverb length", () => {
    expect(wetGain(0)).toBe(0);
    expect(wetGain(100)).toBe(1);
    expect(masterGain(100)).toBe(1);
    expect(masterGain(50)).toBe(0.25);
    expect(reverbSeconds(0)).toBeCloseTo(0.4);
    expect(reverbSeconds(100)).toBeCloseTo(3.5);
  });
});

describe("generated impulse response", () => {
  const sr = 8000;
  const [l, r] = generateImpulseResponse(sr, 1);
  const energy = (a: Float32Array, from: number, to: number) => {
    let e = 0;
    for (let i = Math.floor(from * a.length); i < Math.floor(to * a.length); i++) e += a[i] * a[i];
    return e;
  };
  it("is stereo with the requested length", () => {
    expect(l.length).toBe(8000);
    expect(r.length).toBe(8000);
  });
  it("decorrelates the channels", () => {
    expect(l).not.toEqual(r);
  });
  it("decays over time", () => {
    expect(energy(l, 0, 0.25)).toBeGreaterThan(10 * energy(l, 0.5, 0.75));
    expect(energy(l, 0.5, 0.75)).toBeGreaterThan(10 * energy(l, 0.75, 1));
  });
  it("starts from silence with a short fade-in and ends nearly silent", () => {
    expect(Math.abs(l[0])).toBe(0);
    expect(Math.abs(l[l.length - 1])).toBeLessThan(0.01);
  });
  it("is finite and bounded", () => {
    for (const v of l) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });
  it("is reproducible by seed", () => {
    expect(generateImpulseResponse(sr, 0.5, 4)[0]).toEqual(generateImpulseResponse(sr, 0.5, 4)[0]);
    expect(generateImpulseResponse(sr, 0.5, 4)[0]).not.toEqual(generateImpulseResponse(sr, 0.5, 5)[0]);
  });
  it("handles a tiny duration", () => {
    expect(generateImpulseResponse(100, 0)[0].length).toBe(1);
  });
  it("builds a context buffer sized by the size knob", () => {
    const ctx = new MockContext();
    ctx.sampleRate = 8000;
    const small = createReverbBuffer(asCtx(ctx), 0);
    const big = createReverbBuffer(asCtx(ctx), 100);
    expect(small.numberOfChannels).toBe(2);
    expect(small.length).toBe(3200);
    expect(big.length).toBe(28000);
    expect(small.getChannelData(0)).toEqual(generateImpulseResponse(8000, 0.4)[0]);
  });
});

describe("Effects graph", () => {
  const build = (fx: FxSettings = FX_DEFAULTS, tempo = 120) => {
    const ctx = new MockContext();
    ctx.sampleRate = 8000;
    const e = new Effects(asCtx(ctx), fx, tempo);
    return { ctx, e };
  };
  const reaches = (from: unknown, target: unknown, seen = new Set<unknown>()): boolean => {
    if (from === target) return true;
    if (seen.has(from) || !(from instanceof MockNode)) return false;
    seen.add(from);
    return from.connections.some((c) => reaches(c, target, seen));
  };

  it("routes the input through the compressor and analyser to the destination", () => {
    const { ctx, e } = build();
    expect(reaches(e.input, ctx.destination)).toBe(true);
    const comp = ctx.all<MockCompressor>("compressor")[0];
    expect(reaches(e.input, comp)).toBe(true);
    expect(reaches(comp, e.analyser)).toBe(true);
    expect((e.analyser as unknown as MockAnalyser).fftSize).toBe(2048);
    expect((e.analyser as unknown as MockAnalyser).maxDecibels).toBeGreaterThan((e.analyser as unknown as MockAnalyser).minDecibels);
    expect(ctx.destination.connections).toEqual([]);
  });

  it("has a delay path and a reverb path that both rejoin the compressor", () => {
    const { ctx, e } = build();
    const comp = ctx.all<MockCompressor>("compressor")[0];
    const delay = ctx.all<MockDelay>("delay")[0];
    const verb = ctx.all<MockConvolver>("convolver")[0];
    expect(reaches(e.input, delay)).toBe(true);
    expect(reaches(delay, comp)).toBe(true);
    expect(reaches(e.input, verb)).toBe(true);
    expect(reaches(verb, comp)).toBe(true);
  });

  it("feeds the delay back into itself through a low-pass", () => {
    const { ctx } = build();
    const delay = ctx.all<MockDelay>("delay")[0];
    const tone = ctx.all<MockBiquad>("biquad")[0];
    expect(tone.type).toBe("lowpass");
    expect(delay.connections).toEqual([tone]);
    const fb = tone.connections.find((c) => (c as MockNode).connections.includes(delay));
    expect(fb).toBeDefined();
  });

  it("sets the delay time from tempo and division", () => {
    const { ctx } = build({ ...FX_DEFAULTS, delayDiv: 3 }, 90);
    expect(ctx.all<MockDelay>("delay")[0].delayTime.value).toBeCloseTo((60 / 90) * 1);
    expect(ctx.all<MockDelay>("delay")[0].maxDelayTime).toBe(4);
  });

  it("applies compressor, feedback, wet and master settings", () => {
    const fx: FxSettings = { comp: 100, delayDiv: 1, delayFb: 100, delayMix: 50, reverbSize: 20, reverbMix: 30, master: 50 };
    const { ctx } = build(fx);
    const comp = ctx.all<MockCompressor>("compressor")[0];
    expect(comp.threshold.value).toBe(-32);
    expect(comp.ratio.value).toBe(12);
    const gains = ctx.all<MockGain>("gain").map((g) => g.gain.value);
    expect(gains).toContain(MAX_FEEDBACK);
    expect(gains).toContain(0.5);
    expect(gains).toContain(0.3);
    expect(gains).toContain(0.25);
  });

  it("smooths later changes instead of jumping", () => {
    const { ctx, e } = build();
    ctx.currentTime = 3;
    e.apply({ ...FX_DEFAULTS, delayMix: 80, comp: 90 }, 140);
    const delay = ctx.all<MockDelay>("delay")[0];
    const t = delay.delayTime.of("target")[0];
    expect(t.time).toBe(3);
    expect(t.value).toBeCloseTo(delayTimeSeconds(140, FX_DEFAULTS.delayDiv));
    expect(t.timeConstant).toBeGreaterThan(0);
    expect(ctx.all<MockCompressor>("compressor")[0].threshold.of("target")).toHaveLength(1);
  });

  it("generates the reverb impulse once and only regenerates when the size changes", () => {
    const { ctx, e } = build();
    const verb = ctx.all<MockConvolver>("convolver")[0];
    const first = verb.buffer;
    expect(first).not.toBeNull();
    expect(first!.numberOfChannels).toBe(2);
    e.apply({ ...FX_DEFAULTS, delayMix: 10 }, 120);
    expect(verb.buffer).toBe(first);
    e.apply({ ...FX_DEFAULTS, reverbSize: 90 }, 120);
    expect(verb.buffer).not.toBe(first);
    expect(verb.buffer!.length).toBeGreaterThan(first!.length);
  });

  it("works with the default state's settings", () => {
    const { ctx } = build(createDefaultState().fx);
    expect(ctx.nodes.length).toBeGreaterThan(8);
  });
});
