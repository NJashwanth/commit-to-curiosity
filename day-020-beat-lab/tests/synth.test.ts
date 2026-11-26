import { describe, expect, it } from "vitest";
import {
  CUT_TAU,
  MIN_STAGE,
  SYNTH_DEFAULTS,
  SynthVoice,
  WAVES,
  adsrFromKnobs,
  adsrLevel,
  applyPlan,
  cutoffHz,
  envOctaves,
  evalPlan,
  glideSeconds,
  planEnvelope,
  resonanceDb,
  synthLevel,
  waveType,
  type Adsr,
  type SynthParams,
} from "../src/synth";
import { MockBiquad, MockContext, MockGain, MockNode, MockOscillator, MockParam, asCtx, asNode } from "./mock-audio";

const env: Adsr = { attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.4 };

describe("adsrLevel at key times", () => {
  it("is silent before the note and at its start", () => {
    expect(adsrLevel(env, -1, 1)).toBe(0);
    expect(adsrLevel(env, 0, 1)).toBe(0);
  });
  it("rises linearly through the attack", () => {
    expect(adsrLevel(env, 0.05, 1)).toBeCloseTo(0.5);
    expect(adsrLevel(env, 0.1, 1)).toBeCloseTo(1);
  });
  it("falls linearly through the decay to the sustain level", () => {
    expect(adsrLevel(env, 0.2, 1)).toBeCloseTo(0.75);
    expect(adsrLevel(env, 0.3, 1)).toBeCloseTo(0.5);
  });
  it("holds the sustain level until the key is released", () => {
    expect(adsrLevel(env, 0.8, 1)).toBeCloseTo(0.5);
    expect(adsrLevel(env, 0.999, 1)).toBeCloseTo(0.5);
  });
  it("releases linearly from the sustain level to zero", () => {
    expect(adsrLevel(env, 1.0, 1)).toBeCloseTo(0.5);
    expect(adsrLevel(env, 1.2, 1)).toBeCloseTo(0.25);
    expect(adsrLevel(env, 1.4, 1)).toBeCloseTo(0);
    expect(adsrLevel(env, 5, 1)).toBe(0);
  });
  it("starts the release from the partial level when released during the attack", () => {
    const slow: Adsr = { attack: 0.4, decay: 0.2, sustain: 0.6, release: 0.2 };
    expect(adsrLevel(slow, 0.2, 0.2)).toBeCloseTo(0.5); // key up halfway up the attack
    expect(adsrLevel(slow, 0.3, 0.2)).toBeCloseTo(0.25); // halfway through the release
    expect(adsrLevel(slow, 0.4, 0.2)).toBeCloseTo(0);
    // It never reaches the peak.
    for (let t = 0; t < 1; t += 0.01) expect(adsrLevel(slow, t, 0.2)).toBeLessThanOrEqual(0.5 + 1e-9);
  });
  it("starts the release from mid-decay when released during the decay", () => {
    const e: Adsr = { attack: 0.1, decay: 0.4, sustain: 0.2, release: 0.5 };
    expect(adsrLevel(e, 0.3, 0.3)).toBeCloseTo(0.6);
    expect(adsrLevel(e, 0.55, 0.3)).toBeCloseTo(0.3);
  });
  it("treats zero-length stages as the minimum so nothing divides by zero", () => {
    const snap: Adsr = { attack: 0, decay: 0, sustain: 0.4, release: 0 };
    expect(adsrLevel(snap, MIN_STAGE, 1)).toBeCloseTo(1);
    expect(adsrLevel(snap, 0.5, 1)).toBeCloseTo(0.4);
    expect(adsrLevel(snap, 1 + MIN_STAGE, 1)).toBeCloseTo(0, 9);
  });
});

describe("planEnvelope", () => {
  const cases: Array<[string, Adsr, number]> = [
    ["held past decay", env, 1],
    ["released in attack", { attack: 0.4, decay: 0.2, sustain: 0.6, release: 0.2 }, 0.2],
    ["released in decay", { attack: 0.1, decay: 0.4, sustain: 0.2, release: 0.5 }, 0.3],
    ["instant stages", { attack: 0, decay: 0, sustain: 0.3, release: 0 }, 0.5],
    ["zero gate", env, 0],
  ];
  it.each(cases)("matches adsrLevel everywhere: %s", (_name, e, gate) => {
    const plan = planEnvelope(e, gate);
    const g = Math.max(gate, MIN_STAGE);
    for (let t = 0; t < g + e.release + 0.5; t += 0.0137) {
      expect(evalPlan(plan, t)).toBeCloseTo(adsrLevel(e, t, g), 6);
    }
  });
  it("has increasing times, starts and ends at zero", () => {
    const plan = planEnvelope(env, 1);
    expect(plan[0]).toEqual({ t: 0, v: 0 });
    expect(plan[plan.length - 1].v).toBe(0);
    expect(plan[plan.length - 1].t).toBeCloseTo(1.4);
    for (let i = 1; i < plan.length; i++) expect(plan[i].t).toBeGreaterThanOrEqual(plan[i - 1].t);
  });
  it("evalPlan holds ends and tolerates coincident points", () => {
    expect(evalPlan([{ t: 0, v: 0 }, { t: 1, v: 1 }], -1)).toBe(0);
    expect(evalPlan([{ t: 0, v: 0 }, { t: 1, v: 1 }], 9)).toBe(1);
    expect(evalPlan([{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 1, v: 0.5 }], 1)).toBe(1);
    expect(evalPlan([{ t: 0, v: 0 }, { t: 0, v: 1 }], 0.0)).toBe(0);
  });
  it("applyPlan writes one set and one ramp per segment, scaled and offset", () => {
    const p = new MockParam();
    applyPlan(p as unknown as AudioParam, planEnvelope(env, 1), 10, 2, 5);
    expect(p.events[0]).toEqual({ type: "set", time: 10, value: 5 });
    expect(p.of("linear").map((e) => e.time)).toEqual([10.1, 10.3, 11, 11.4].map((x) => expect.closeTo(x, 9)));
    expect(p.of("linear")[0].value).toBe(7);
    expect(p.of("linear").at(-1)!.value).toBe(5);
  });
});

describe("knob mapping", () => {
  it("maps ADSR knobs to sensible times", () => {
    const lo = adsrFromKnobs({ attack: 0, decay: 0, sustain: 0, release: 0 });
    const hi = adsrFromKnobs({ attack: 100, decay: 100, sustain: 100, release: 100 });
    expect(lo.attack).toBeCloseTo(MIN_STAGE);
    expect(hi.attack).toBeCloseTo(1.5);
    expect(hi.decay).toBeCloseTo(2);
    expect(hi.release).toBeCloseTo(2.5);
    expect(lo.sustain).toBe(0);
    expect(hi.sustain).toBe(1);
  });
  it("maps filter, glide and level knobs", () => {
    expect(cutoffHz(0)).toBeCloseTo(40);
    expect(cutoffHz(100)).toBeCloseTo(14000);
    expect(resonanceDb(0)).toBe(0);
    expect(resonanceDb(100)).toBe(22);
    expect(envOctaves(100)).toBe(5);
    expect(glideSeconds(0)).toBe(0);
    expect(glideSeconds(100)).toBeCloseTo(0.35);
    expect(synthLevel(0)).toBe(0);
    expect(synthLevel(100)).toBeCloseTo(0.4);
  });
  it("maps wave indexes, falling back to sine", () => {
    expect(WAVES.map((_, i) => waveType(i))).toEqual(["sine", "square", "sawtooth", "triangle"]);
    expect(waveType(9)).toBe("sine");
  });
});

describe("SynthVoice", () => {
  const setup = () => {
    const ctx = new MockContext();
    const out = new MockNode("out");
    return { ctx, out, voice: new SynthVoice(asCtx(ctx), asNode(out)) };
  };
  const params = (over: Partial<SynthParams> = {}): SynthParams => ({ ...SYNTH_DEFAULTS, ...over });

  it("builds osc -> lowpass -> amp -> cut -> out and starts and stops the oscillator", () => {
    const { ctx, out, voice } = setup();
    voice.noteOn(2, 57, 0.2, params({ wave: 1 }));
    const osc = ctx.all<MockOscillator>("oscillator")[0];
    const filter = ctx.all<MockBiquad>("biquad")[0];
    const [amp, cut] = ctx.all<MockGain>("gain");
    expect(osc.type).toBe("square");
    expect(osc.frequency.of("set")[0]).toEqual({ type: "set", time: 2, value: expect.closeTo(220, 6) });
    expect(osc.startedAt).toBe(2);
    expect(osc.stoppedAt!).toBeGreaterThan(2.2);
    expect(osc.connections).toEqual([filter]);
    expect(filter.connections).toEqual([amp]);
    expect(amp.connections).toEqual([cut]);
    expect(cut.connections).toEqual([out]);
    expect(filter.type).toBe("lowpass");
    expect(filter.frequency.value).toBeCloseTo(cutoffHz(45));
    expect(filter.Q.value).toBeCloseTo(resonanceDb(30));
  });

  it("shapes amp gain with the ADSR and scales it by level and velocity", () => {
    const { ctx, voice } = setup();
    const p = params({ attack: 20, decay: 40, sustain: 50, release: 30, level: 100 });
    voice.noteOn(1, 60, 0.5, p, 0.5);
    const amp = ctx.all<MockGain>("gain")[0].gain;
    const e = adsrFromKnobs(p);
    const peak = synthLevel(100) * 0.5;
    expect(amp.events[0]).toEqual({ type: "set", time: 1, value: 0 });
    const ramps = amp.of("linear");
    expect(ramps[0].time).toBeCloseTo(1 + e.attack);
    expect(ramps[0].value).toBeCloseTo(peak);
    expect(ramps.at(-1)!.time).toBeCloseTo(1 + 0.5 + e.release);
    expect(ramps.at(-1)!.value).toBe(0);
  });

  it("sweeps the filter in cents by the envelope amount", () => {
    const { ctx, voice } = setup();
    voice.noteOn(0, 48, 0.4, params({ envAmt: 100, attack: 0 }));
    const detune = ctx.all<MockBiquad>("biquad")[0].detune;
    expect(Math.max(...detune.of("linear").map((e) => e.value))).toBeCloseTo(5 * 1200);
    const flat = setup();
    flat.voice.noteOn(0, 48, 0.4, params({ envAmt: 0 }));
    expect(Math.max(...flat.ctx.all<MockBiquad>("biquad")[0].detune.of("linear").map((e) => e.value))).toBe(0);
  });

  it("glides from the previous pitch when glide is up, and jumps when it is zero", () => {
    const g = setup();
    g.voice.noteOn(0, 36, 0.2, params({ glide: 100 }));
    g.voice.noteOn(1, 48, 0.2, params({ glide: 100 }));
    const second = g.ctx.all<MockOscillator>("oscillator")[1];
    expect(second.frequency.of("set")[0].value).toBeCloseTo(65.406, 2);
    expect(second.frequency.of("exp")[0]).toEqual({ type: "exp", time: expect.closeTo(1.35, 9), value: expect.closeTo(130.81, 2) });

    const j = setup();
    j.voice.noteOn(0, 36, 0.2, params({ glide: 0 }));
    j.voice.noteOn(1, 48, 0.2, params({ glide: 0 }));
    expect(j.ctx.all<MockOscillator>("oscillator")[1].frequency.of("exp")).toHaveLength(0);

    const same = setup();
    same.voice.noteOn(0, 36, 0.2, params({ glide: 100 }));
    same.voice.noteOn(1, 36, 0.2, params({ glide: 100 }));
    expect(same.ctx.all<MockOscillator>("oscillator")[1].frequency.of("exp")).toHaveLength(0);
  });

  it("does not glide into the very first note", () => {
    const { ctx, voice } = setup();
    voice.noteOn(0, 40, 0.2, params({ glide: 100 }));
    expect(ctx.all<MockOscillator>("oscillator")[0].frequency.of("exp")).toHaveLength(0);
  });

  it("cuts a note that is still sounding when the next begins", () => {
    const { ctx, voice } = setup();
    voice.noteOn(0, 36, 0.3, params({ release: 100 }));
    voice.noteOn(0.25, 40, 0.1, params());
    const firstCut = ctx.all<MockGain>("gain")[1].gain;
    expect(firstCut.of("target")).toEqual([{ type: "target", time: 0.25, value: 0, timeConstant: CUT_TAU }]);
  });

  it("leaves a finished note alone", () => {
    const { ctx, voice } = setup();
    voice.noteOn(0, 36, 0.1, params({ release: 0 }));
    voice.noteOn(5, 40, 0.1, params());
    expect(ctx.all<MockGain>("gain")[1].gain.of("target")).toHaveLength(0);
  });
});
