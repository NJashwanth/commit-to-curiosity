import { describe, expect, it } from "vitest";
import {
  CHOKE_TAU,
  DRUM_DEFAULTS,
  DRUM_IDS,
  DRUM_LABELS,
  DrumKit,
  decayScale,
  levelGain,
  tuneRatio,
  type DrumId,
} from "../src/drums";
import { MockBufferSource, MockContext, MockGain, MockNode, MockOscillator, asCtx, asNode } from "./mock-audio";

function setup(seed?: number) {
  const ctx = new MockContext();
  const out = new MockNode("out");
  const kit = new DrumKit(asCtx(ctx), asNode(out), seed);
  return { ctx, out, kit };
}

const sources = (ctx: MockContext) => [...ctx.all<MockOscillator>("oscillator"), ...ctx.all<MockBufferSource>("bufferSource")];

/** Is `target` reachable from `from` by following connect() calls? */
function reaches(from: MockNode, target: MockNode): boolean {
  const seen = new Set<unknown>();
  const walk = (n: unknown): boolean => {
    if (n === target) return true;
    if (seen.has(n) || !(n instanceof MockNode)) return false;
    seen.add(n);
    return n.connections.some(walk);
  };
  return walk(from);
}

const latestStop = (ctx: MockContext) => Math.max(...sources(ctx).map((s) => s.stoppedAt ?? 0));

describe("parameter mapping", () => {
  it("tune is an octave either way", () => {
    expect(tuneRatio(50)).toBe(1);
    expect(tuneRatio(100)).toBe(2);
    expect(tuneRatio(0)).toBe(0.5);
  });
  it("decay grows with the knob", () => {
    expect(decayScale(50)).toBe(1);
    expect(decayScale(0)).toBeLessThan(0.4);
    expect(decayScale(100)).toBeGreaterThan(3);
    expect(decayScale(75)).toBeGreaterThan(decayScale(25));
  });
  it("level is silent at 0, unity at 100, and clamped", () => {
    expect(levelGain(0)).toBe(0);
    expect(levelGain(100)).toBe(1);
    expect(levelGain(50)).toBe(0.25);
    expect(levelGain(500)).toBe(1);
    expect(levelGain(-5)).toBe(0);
  });
  it("has eight uniquely named drums with in-range defaults", () => {
    expect(DRUM_IDS).toHaveLength(8);
    expect(new Set(DRUM_IDS).size).toBe(8);
    for (const id of DRUM_IDS) {
      expect(DRUM_LABELS[id]).toBeTruthy();
      for (const v of Object.values(DRUM_DEFAULTS[id])) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe.each(DRUM_IDS)("%s voice", (id: DrumId) => {
  it("starts and stops every source, in order, and reaches the output", () => {
    const { ctx, out, kit } = setup();
    kit.trigger(id, 1.5, DRUM_DEFAULTS[id]);
    const srcs = sources(ctx);
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) {
      expect(s.startedAt).not.toBeNull();
      expect(s.startedAt!).toBeGreaterThanOrEqual(1.5);
      expect(s.stoppedAt!).toBeGreaterThan(s.startedAt!);
      expect(reaches(s, out)).toBe(true);
    }
  });

  it("gets longer when decay goes up", () => {
    const short = setup();
    short.kit.trigger(id, 0, { ...DRUM_DEFAULTS[id], decay: 10 });
    const long = setup();
    long.kit.trigger(id, 0, { ...DRUM_DEFAULTS[id], decay: 90 });
    expect(latestStop(long.ctx)).toBeGreaterThan(latestStop(short.ctx));
  });

  it("scales its peak gain with level and velocity", () => {
    const peak = (level: number, vel: number) => {
      const { ctx, kit } = setup();
      kit.trigger(id, 0, { ...DRUM_DEFAULTS[id], level }, vel);
      return Math.max(...ctx.all<MockGain>("gain").map((g) => g.gain.of("set")[0]?.value ?? 0));
    };
    expect(peak(100, 1)).toBeGreaterThan(peak(50, 1));
    expect(peak(100, 1)).toBeGreaterThan(peak(100, 0.5));
    expect(peak(0, 1)).toBe(0);
  });
});

describe("kick", () => {
  it("sweeps a sine from high to low and tune scales the landing pitch", () => {
    const land = (tune: number) => {
      const { ctx, kit } = setup();
      kit.trigger("kick", 2, { ...DRUM_DEFAULTS.kick, tune });
      const body = ctx.all<MockOscillator>("oscillator")[0];
      expect(body.type).toBe("sine");
      const start = body.frequency.of("set")[0];
      const ramp = body.frequency.of("exp")[0];
      expect(start.time).toBe(2);
      expect(ramp.time).toBeGreaterThan(2);
      expect(start.value).toBeGreaterThan(ramp.value * 3);
      return ramp.value;
    };
    expect(land(50)).toBeCloseTo(50);
    expect(land(100) / land(50)).toBeCloseTo(2);
    expect(land(0) / land(50)).toBeCloseTo(0.5);
  });
});

describe("snare, tom, rim, cowbell", () => {
  it("snare mixes noise and a tone", () => {
    const { ctx, kit } = setup();
    kit.trigger("snare", 0, DRUM_DEFAULTS.snare);
    expect(ctx.all("bufferSource").length).toBeGreaterThanOrEqual(1);
    expect(ctx.all("oscillator").length).toBeGreaterThanOrEqual(1);
  });
  it("tom sweeps down to a tunable pitch", () => {
    const { ctx, kit } = setup();
    kit.trigger("tom", 0, { ...DRUM_DEFAULTS.tom, tune: 100 });
    const o = ctx.all<MockOscillator>("oscillator")[0];
    expect(o.frequency.of("exp")[0].value).toBeCloseTo(220);
  });
  it("cowbell uses two square oscillators", () => {
    const { ctx, kit } = setup();
    kit.trigger("cowbell", 0, DRUM_DEFAULTS.cowbell);
    const oscs = ctx.all<MockOscillator>("oscillator");
    expect(oscs.map((o) => o.type)).toEqual(["square", "square"]);
    expect(oscs[1].frequency.of("set")[0].value).toBeGreaterThan(oscs[0].frequency.of("set")[0].value);
  });
});

describe("clap", () => {
  it("layers three bursts and a tail on ascending start times", () => {
    const { ctx, kit } = setup();
    kit.trigger("clap", 1, DRUM_DEFAULTS.clap);
    const starts = ctx.all<MockBufferSource>("bufferSource").map((s) => s.startedAt!);
    expect(starts).toHaveLength(4);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(starts[0]).toBe(1);
    expect(starts[3] - starts[0]).toBeGreaterThan(0.02);
  });
});

describe("hi-hat choke", () => {
  it("a closed hat cuts a ringing open hat", () => {
    const { kit } = setup();
    kit.trigger("ohat", 0, DRUM_DEFAULTS.ohat);
    const open = kit.openHat!;
    expect(open).not.toBeNull();
    kit.trigger("chat", 0.25, DRUM_DEFAULTS.chat);
    const target = open.gain.gain as unknown as MockGain["gain"];
    const cuts = target.of("target").filter((e) => e.time === 0.25);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].value).toBe(0);
    expect(cuts[0].timeConstant).toBe(CHOKE_TAU);
    expect(kit.openHat).toBeNull();
  });

  it("does not choke an open hat that has already died away", () => {
    const { kit } = setup();
    kit.trigger("ohat", 0, DRUM_DEFAULTS.ohat);
    const open = kit.openHat!;
    kit.trigger("chat", 30, DRUM_DEFAULTS.chat);
    const target = open.gain.gain as unknown as MockGain["gain"];
    expect(target.of("target").filter((e) => e.time === 30)).toHaveLength(0);
  });

  it("a new open hat chokes the previous one, and other drums do not", () => {
    const { kit } = setup();
    kit.trigger("ohat", 0, DRUM_DEFAULTS.ohat);
    const first = kit.openHat!;
    kit.trigger("kick", 0.1, DRUM_DEFAULTS.kick);
    expect(kit.openHat).toBe(first);
    kit.trigger("ohat", 0.2, DRUM_DEFAULTS.ohat);
    expect(kit.openHat).not.toBe(first);
    const target = first.gain.gain as unknown as MockGain["gain"];
    expect(target.of("target").some((e) => e.time === 0.2 && e.value === 0)).toBe(true);
  });

  it("choke returns false when nothing is ringing", () => {
    expect(setup().kit.choke(1)).toBe(false);
  });
});

describe("kit", () => {
  it("rejects an unknown drum", () => {
    expect(() => setup().kit.trigger("gong" as DrumId, 0, DRUM_DEFAULTS.kick)).toThrow(/Unknown drum/);
  });
  it("is deterministic for a given seed", () => {
    const offsets = (seed: number) => {
      const { ctx, kit } = setup(seed);
      kit.trigger("snare", 0, DRUM_DEFAULTS.snare);
      kit.trigger("clap", 1, DRUM_DEFAULTS.clap);
      return ctx.all<MockBufferSource>("bufferSource").map((s) => s.startOffset);
    };
    expect(offsets(5)).toEqual(offsets(5));
    expect(offsets(5)).not.toEqual(offsets(6));
  });
});
