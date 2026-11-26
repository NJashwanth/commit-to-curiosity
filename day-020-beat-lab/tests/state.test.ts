import { describe, expect, it } from "vitest";
import {
  InvalidStateError,
  NOTE_DEFAULT,
  PATTERN_COUNT,
  STEP_COUNT,
  VEL_DEFAULT,
  assertValidState,
  cloneState,
  createDefaultState,
  emptyPattern,
  validateState,
  type BeatState,
} from "../src/state";

const withChange = (fn: (s: BeatState) => void) => {
  const s = createDefaultState();
  fn(s);
  return validateState(s);
};

describe("default state", () => {
  it("is valid and has the expected shape", () => {
    const s = createDefaultState();
    expect(validateState(s)).toEqual([]);
    expect(s.patterns).toHaveLength(PATTERN_COUNT);
    expect(s.patterns[0].drums).toHaveLength(8);
    expect(s.patterns[0].drums[0]).toHaveLength(STEP_COUNT);
    expect(s.patterns[0].synth).toHaveLength(STEP_COUNT);
    expect(s.tracks).toHaveLength(8);
  });
  it("gives each call its own copy", () => {
    const a = createDefaultState();
    const b = createDefaultState();
    a.patterns[0].drums[0][0].on = true;
    a.tracks[0].level = 1;
    expect(b.patterns[0].drums[0][0].on).toBe(false);
    expect(b.tracks[0].level).not.toBe(1);
  });
  it("cloneState is deep", () => {
    const a = createDefaultState();
    const b = cloneState(a);
    expect(b).toEqual(a);
    b.chain.push(1);
    b.synth.cutoff = 3;
    expect(a.chain).toEqual([]);
    expect(a.synth.cutoff).not.toBe(3);
  });
  it("emptyPattern takes a length", () => {
    expect(emptyPattern(8).length).toBe(8);
    expect(emptyPattern().length).toBe(16);
  });
});

describe("validateState", () => {
  it("rejects things that are not objects", () => {
    for (const v of [null, undefined, 5, "x", [], true]) expect(validateState(v)).toEqual(["state must be an object"]);
  });
  it("checks version, tempo, swing, current and chain mode", () => {
    expect(withChange((s) => (s.version = 2))).toEqual(["version must be 1"]);
    expect(withChange((s) => (s.tempo = 59))[0]).toMatch(/tempo/);
    expect(withChange((s) => (s.tempo = 201))[0]).toMatch(/tempo/);
    expect(withChange((s) => (s.tempo = 120.5))[0]).toMatch(/tempo/);
    expect(withChange((s) => (s.swing = 76))[0]).toMatch(/swing/);
    expect(withChange((s) => (s.swing = -1))[0]).toMatch(/swing/);
    expect(withChange((s) => (s.current = 4))[0]).toMatch(/current/);
    expect(withChange((s) => ((s as unknown as { chainMode: unknown }).chainMode = 1))[0]).toMatch(/chainMode/);
    expect(withChange((s) => (s.tempo = NaN))[0]).toMatch(/tempo/);
  });
  it("checks the chain", () => {
    expect(withChange((s) => (s.chain = [0, 1, 2, 3, 0, 1, 2, 3, 0]))[0]).toMatch(/at most 8/);
    expect(withChange((s) => (s.chain = [0, 4]))[0]).toMatch(/chain\[1\]/);
    expect(withChange((s) => ((s as unknown as { chain: unknown }).chain = "x"))[0]).toMatch(/chain/);
    expect(withChange((s) => (s.chain = [3, 0, 2]))).toEqual([]);
  });
  it("checks patterns", () => {
    expect(withChange((s) => s.patterns.pop())[0]).toMatch(/4 slots/);
    expect(withChange((s) => ((s.patterns[1] as unknown as { length: number }).length = 12))[0]).toMatch(/patterns\[1\]\.length/);
    expect(withChange((s) => s.patterns[0].drums.pop())[0]).toMatch(/8 tracks/);
    expect(withChange((s) => s.patterns[0].drums[2].pop())[0]).toMatch(/drums\[2\]/);
    expect(withChange((s) => s.patterns[0].synth.pop())[0]).toMatch(/synth must have/);
    expect(withChange((s) => ((s.patterns as unknown[])[2] = 7))[0]).toMatch(/patterns\[2\] must be an object/);
    expect(withChange((s) => ((s.patterns[0].drums[0] as unknown[])[3] = null))[0]).toMatch(/\[3\] must be an object/);
  });
  it("checks step fields", () => {
    expect(withChange((s) => (s.patterns[0].drums[0][0].vel = 17))[0]).toMatch(/vel/);
    expect(withChange((s) => (s.patterns[0].drums[0][0].vel = 0))[0]).toMatch(/vel/);
    expect(withChange((s) => ((s.patterns[0].drums[0][0] as unknown as { on: unknown }).on = "yes"))[0]).toMatch(/\.on/);
    expect(withChange((s) => (s.patterns[0].synth[0].note = 200))[0]).toMatch(/note/);
  });
  it("requires off steps to be in their default form", () => {
    expect(withChange((s) => (s.patterns[0].drums[0][5].accent = true))[0]).toMatch(/is off/);
    expect(withChange((s) => (s.patterns[0].drums[0][5].vel = 5))[0]).toMatch(/is off/);
    expect(withChange((s) => (s.patterns[0].synth[5].note = 60))[0]).toMatch(/is off/);
    expect(
      withChange((s) => {
        const st = s.patterns[0].synth[5];
        Object.assign(st, { on: true, note: 60, vel: 9, accent: true });
      }),
    ).toEqual([]);
  });
  it("checks track, synth and fx knobs", () => {
    expect(withChange((s) => s.tracks.pop())[0]).toMatch(/8 entries/);
    expect(withChange((s) => (s.tracks[3].tune = 101))[0]).toMatch(/tracks\[3\]\.tune/);
    expect(withChange((s) => ((s.tracks[0] as unknown as { mute: unknown }).mute = 0))[0]).toMatch(/mute/);
    expect(withChange((s) => ((s as unknown as { tracks: unknown[] }).tracks[1] = null))[0]).toMatch(/tracks\[1\] must be an object/);
    expect(withChange((s) => (s.synth.wave = 4))[0]).toMatch(/synth\.wave/);
    expect(withChange((s) => (s.synth.cutoff = -1))[0]).toMatch(/synth\.cutoff/);
    expect(withChange((s) => ((s.synth as unknown as { solo: unknown }).solo = null))[0]).toMatch(/synth\.solo/);
    expect(withChange((s) => ((s as unknown as { synth: unknown }).synth = 3))[0]).toMatch(/synth must be an object/);
    expect(withChange((s) => (s.fx.delayDiv = 6))[0]).toMatch(/fx\.delayDiv/);
    expect(withChange((s) => (s.fx.master = 1.5))[0]).toMatch(/fx\.master/);
  });
  it("reports every problem, not just the first", () => {
    const problems = withChange((s) => {
      s.tempo = 0;
      s.swing = 99;
      s.fx.comp = 500;
    });
    expect(problems).toHaveLength(3);
  });
});

describe("assertValidState", () => {
  it("passes a valid state and throws a readable error otherwise", () => {
    expect(() => assertValidState(createDefaultState())).not.toThrow();
    const s = createDefaultState();
    s.tempo = 1;
    expect(() => assertValidState(s)).toThrow(InvalidStateError);
    expect(() => assertValidState(s)).toThrow(/Invalid beat: tempo must be an integer from 60 to 200/);
  });
  it("summarises long problem lists", () => {
    const s = createDefaultState();
    s.tempo = 1;
    s.swing = 99;
    s.current = 9;
    s.fx.comp = 500;
    s.fx.master = 500;
    try {
      assertValidState(s);
      expect.unreachable();
    } catch (e) {
      expect((e as InvalidStateError).problems).toHaveLength(5);
      expect((e as Error).message).toMatch(/and 2 more/);
    }
  });
  it("uses the default velocity and note for off steps", () => {
    const p = emptyPattern();
    expect(p.drums[0][0]).toEqual({ on: false, vel: VEL_DEFAULT, accent: false });
    expect(p.synth[0].note).toBe(NOTE_DEFAULT);
  });
});
