import { describe, expect, it } from "vitest";
import { midiToName } from "../src/audio-context";
import { PRESETS, PRESET_IDS, loadPreset, noteNameToMidi, parseDrumRow, parseSynthRow } from "../src/presets";
import { planSong } from "../src/render";
import { Sequencer } from "../src/sequencer";
import { STEP_COUNT, validateState } from "../src/state";
import { decodeState, encodeState } from "../src/url-codec";

describe("the four built-in beats", () => {
  it("are boom bap, house, trap and commit-to-curiosity", () => {
    expect(PRESET_IDS).toEqual(["boom-bap", "house", "trap", "commit-to-curiosity"]);
    expect(PRESETS.map((p) => p.name)).toEqual(["Boom bap", "House", "Trap", "commit-to-curiosity"]);
  });
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s passes state validation", (_id, p) => {
    expect(validateState(p.state)).toEqual([]);
    expect(p.description.length).toBeGreaterThan(20);
  });
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s loads into a sequencer and makes sound", (_id, p) => {
    const q = new Sequencer(structuredClone(p.state));
    q.start();
    let hits = 0;
    for (let step = 0; step < q.playLength; step++) hits += q.eventsAt(step).length;
    expect(hits).toBeGreaterThan(8);
  });
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s survives a share link", (_id, p) => {
    expect(decodeState(encodeState(p.state))).toEqual(p.state);
  });
  it("have the tempos and character they promise", () => {
    const by = Object.fromEntries(PRESETS.map((p) => [p.id, p.state]));
    expect(by["boom-bap"].tempo).toBe(90);
    expect(by["boom-bap"].swing).toBeGreaterThan(40);
    expect(by.house.tempo).toBe(124);
    expect(by.trap.tempo).toBe(140);
    expect(by.trap.swing).toBe(0);
    // house is four on the floor
    const kick = by.house.patterns[0].drums[0];
    expect([0, 4, 8, 12].every((i) => kick[i].on)).toBe(true);
    expect(kick.filter((s) => s.on)).toHaveLength(4);
  });
  it("commit-to-curiosity builds one pattern at a time over a four-pattern chain", () => {
    const s = PRESETS[3].state;
    expect(s.chainMode).toBe(true);
    expect(s.chain).toEqual([0, 1, 2, 3]);
    const count = (slot: number) => {
      const p = s.patterns[slot];
      return p.drums.flat().filter((x) => x.on).length + p.synth.filter((x) => x.on).length;
    };
    expect(count(1)).toBeGreaterThan(count(0));
    expect(count(2)).toBeGreaterThan(count(0));
    // its four bars are exactly its four patterns, in order
    const { steps } = planSong(s, 4);
    expect([0, 16, 32, 48].map((i) => steps[i].pattern)).toEqual([0, 1, 2, 3]);
    expect(steps[63].events.length).toBeGreaterThan(0);
  });
  it("loadPreset returns independent copies", () => {
    const a = loadPreset("trap")!;
    a.tempo = 99;
    a.patterns[0].drums[0][0].vel = 2;
    expect(loadPreset("trap")!.tempo).toBe(140);
    expect(loadPreset("trap")).toEqual(PRESETS[2].state);
    expect(loadPreset("nope")).toBeNull();
  });
});

describe("pattern notation", () => {
  it("parses drum rows", () => {
    const row = parseDrumRow("X.x o|.");
    expect(row).toHaveLength(STEP_COUNT);
    expect(row[0]).toEqual({ on: true, vel: 16, accent: true });
    expect(row[1].on).toBe(false);
    expect(row[2]).toEqual({ on: true, vel: 12, accent: false });
    expect(row[3]).toEqual({ on: true, vel: 6, accent: false });
    expect(row[4].on).toBe(false);
    expect(row[31].on).toBe(false);
  });
  it("rejects bad drum rows", () => {
    expect(() => parseDrumRow("x?x")).toThrow(/Unknown drum symbol/);
    expect(() => parseDrumRow("x".repeat(33))).toThrow(/33 steps/);
  });
  it("parses note names", () => {
    expect(noteNameToMidi("C2")).toBe(36);
    expect(noteNameToMidi("A4")).toBe(69);
    expect(noteNameToMidi("A#1")).toBe(34);
    expect(noteNameToMidi("Bb1")).toBe(34);
    expect(noteNameToMidi("c-1")).toBe(0);
    expect(() => noteNameToMidi("H2")).toThrow(/Bad note/);
    expect(() => noteNameToMidi("A9")).toThrow(/outside/);
    expect(() => noteNameToMidi("Cb-1")).toThrow(/outside/);
  });
  it("agrees with midiToName", () => {
    for (let n = 12; n < 120; n++) expect(noteNameToMidi(midiToName(n))).toBe(n);
  });
  it("parses synth rows with rests and accents", () => {
    const row = parseSynthRow("C2 . D2! | E2");
    expect(row).toHaveLength(STEP_COUNT);
    expect(row[0]).toMatchObject({ on: true, note: 36, accent: false, vel: 12 });
    expect(row[1].on).toBe(false);
    expect(row[2]).toMatchObject({ on: true, note: 38, accent: true, vel: 16 });
    expect(row[3]).toMatchObject({ on: true, note: 40 });
    expect(row[4].on).toBe(false);
    expect(() => parseSynthRow(Array(33).fill("C2").join(" "))).toThrow(/33 steps/);
  });
});
