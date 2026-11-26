// Four built-in beats, written in a compact text notation so they are easy
// to read and edit:
//   drum rows:  X accent, x normal hit, o soft hit, . rest   ("|" and spaces are ignored)
//   synth rows: note names separated by spaces, "." for a rest, "!" after a note for an accent
import { DRUM_IDS, type DrumId, type DrumParams } from "./drums";
import type { SynthParams } from "./synth";
import {
  NOTE_DEFAULT,
  STEP_COUNT,
  VEL_DEFAULT,
  assertValidState,
  cloneState,
  createDefaultState,
  type BeatState,
  type DrumStep,
  type FxSettings,
  type PatternLength,
  type SynthStep,
} from "./state";

const DRUM_CHARS: Record<string, Pick<DrumStep, "vel" | "accent"> | null> = {
  X: { vel: 16, accent: true },
  x: { vel: VEL_DEFAULT, accent: false },
  o: { vel: 6, accent: false },
  ".": null,
};

export function parseDrumRow(text: string): DrumStep[] {
  const chars = [...text].filter((c) => c !== " " && c !== "|");
  if (chars.length > STEP_COUNT) throw new Error(`Drum row has ${chars.length} steps; the most is ${STEP_COUNT}`);
  return Array.from({ length: STEP_COUNT }, (_, i) => {
    const c = chars[i] ?? ".";
    if (!(c in DRUM_CHARS)) throw new Error(`Unknown drum symbol "${c}"`);
    const hit = DRUM_CHARS[c];
    return hit ? { on: true, ...hit } : { on: false, vel: VEL_DEFAULT, accent: false };
  });
}

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C2" is MIDI 36, "A#1" is 34, "Bb1" is 34. */
export function noteNameToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`Bad note name "${name}"`);
  const shift = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  const midi = (Number(m[3]) + 1) * 12 + SEMITONES[m[1].toUpperCase()] + shift;
  if (midi < 0 || midi > 127) throw new Error(`Note "${name}" is outside the MIDI range`);
  return midi;
}

export function parseSynthRow(text: string): SynthStep[] {
  const tokens = text.split(/[\s|]+/).filter(Boolean);
  if (tokens.length > STEP_COUNT) throw new Error(`Synth row has ${tokens.length} steps; the most is ${STEP_COUNT}`);
  return Array.from({ length: STEP_COUNT }, (_, i) => {
    const tok = tokens[i] ?? ".";
    if (tok === ".") return { on: false, vel: VEL_DEFAULT, accent: false, note: NOTE_DEFAULT };
    const accent = tok.endsWith("!");
    return { on: true, vel: accent ? 16 : VEL_DEFAULT, accent, note: noteNameToMidi(accent ? tok.slice(0, -1) : tok) };
  });
}

type PatternDef = Partial<Record<DrumId | "synth", string>> & { length?: PatternLength };

interface PresetDef {
  id: string;
  name: string;
  description: string;
  tempo: number;
  swing: number;
  chain?: number[];
  patterns: PatternDef[];
  drums?: Partial<Record<DrumId, Partial<DrumParams>>>;
  synth?: Partial<SynthParams>;
  fx?: Partial<FxSettings>;
}

function build(def: PresetDef): BeatState {
  const s = createDefaultState();
  s.tempo = def.tempo;
  s.swing = def.swing;
  if (def.chain) {
    s.chain = [...def.chain];
    s.chainMode = true;
  }
  def.patterns.forEach((pd, slot) => {
    const p = s.patterns[slot];
    if (pd.length) p.length = pd.length;
    DRUM_IDS.forEach((id, t) => {
      if (pd[id]) p.drums[t] = parseDrumRow(pd[id]!);
    });
    if (pd.synth) p.synth = parseSynthRow(pd.synth);
  });
  DRUM_IDS.forEach((id, t) => Object.assign(s.tracks[t], def.drums?.[id]));
  Object.assign(s.synth, def.synth);
  Object.assign(s.fx, def.fx);
  return s;
}

const DEFS: PresetDef[] = [
  {
    id: "boom-bap",
    name: "Boom bap",
    description: "90 BPM, lazy swing, ghost snares and a sine bass. Pattern B adds a clap layer and a tom fill.",
    tempo: 90,
    swing: 55,
    chain: [0, 0, 1, 1],
    patterns: [
      {
        kick: "X......x..x....x",
        snare: "....X.......X..o",
        chat: "X.o.x.o.X.o.x.o.",
        ohat: "..............o.",
        rim: ".......o........",
        synth: "A1 . . . . . . A1 . . C2 . . . E2 .",
      },
      {
        kick: "X......x..x..x..",
        snare: "....X.....o.X.o.",
        clap: "....x.......x...",
        chat: "X.o.x.o.X.o.x.xo",
        ohat: ".........o......",
        tom: "..............xx",
        synth: "A1 . . . . . A1 . . C2 . . G1 . E2 .",
      },
    ],
    drums: { kick: { tune: 46, decay: 55, level: 92 }, snare: { tune: 44, decay: 45, level: 78 }, chat: { level: 45 }, clap: { level: 55 }, tom: { tune: 40, level: 65 } },
    synth: { wave: 0, attack: 3, decay: 40, sustain: 55, release: 30, cutoff: 35, resonance: 10, envAmt: 20, glide: 15, level: 85 },
    fx: { comp: 55, delayMix: 8, reverbMix: 14, delayDiv: 2 },
  },
  {
    id: "house",
    name: "House",
    description: "124 BPM four-on-the-floor with off-beat open hats and a saw bass stab. Pattern B brings in a cowbell and a rim.",
    tempo: 124,
    swing: 12,
    chain: [0, 0, 1, 1],
    patterns: [
      {
        kick: "X...X...X...X...",
        clap: "....X.......X...",
        chat: "x.ox.ox.x.ox.oxo",
        ohat: "..x...x...x...x.",
        synth: ". . A1! . . . A1 . . . A1! . . . C2 .",
      },
      {
        kick: "X...X...X...X...",
        clap: "....X.......X..x",
        chat: "x.ox.ox.x.ox.oxo",
        ohat: "..x...x...x...x.",
        rim: ".o..o..o.o..o...",
        cowbell: "......o.......o.",
        synth: ". . D2! . . . D2 . . . C2! . . . A1 .",
      },
    ],
    drums: { kick: { tune: 52, decay: 42, level: 95 }, clap: { decay: 55, level: 62 }, chat: { level: 42 }, ohat: { decay: 45, level: 50 }, rim: { level: 50 }, cowbell: { tune: 55, level: 38 } },
    synth: { wave: 2, attack: 2, decay: 30, sustain: 10, release: 20, cutoff: 38, resonance: 45, envAmt: 70, glide: 0, level: 68 },
    fx: { comp: 50, delayMix: 22, delayDiv: 2, delayFb: 40, reverbMix: 16 },
  },
  {
    id: "trap",
    name: "Trap",
    description: "140 BPM half-time, an 808 kick with a long tail, rolling hats and a gliding sub bass.",
    tempo: 140,
    swing: 0,
    chain: [0, 1, 0, 2],
    patterns: [
      {
        kick: "X.....x...x.....",
        snare: "........X.......",
        clap: "........x.......",
        chat: "x.xoxoxox.xoxoxo",
        ohat: "..............x.",
        synth: "F1 . . . . . F1 . . . G#1 . . . . .",
      },
      {
        kick: "X.....x...x...x.",
        snare: "........X.......",
        clap: "........x.......",
        chat: "xoxoxoxoxxxxxoxo",
        ohat: "..............x.",
        synth: "F1 . . . . . F1 . . . G#1 . . . C2 .",
      },
      {
        kick: "X...............",
        snare: "........X..o.o.x",
        clap: "........x..o.o.x",
        chat: "xoxoxoxoxxxxxxxx",
        tom: "............x.xx",
        synth: "F1 . . . . . . . . . . . . . . .",
      },
    ],
    drums: { kick: { tune: 30, decay: 85, level: 96 }, snare: { decay: 40, level: 60 }, clap: { level: 78 }, chat: { tune: 60, decay: 30, level: 42 }, ohat: { level: 45 }, tom: { tune: 35, level: 70 } },
    synth: { wave: 0, attack: 0, decay: 60, sustain: 70, release: 55, cutoff: 30, resonance: 5, envAmt: 10, glide: 45, level: 90 },
    fx: { comp: 60, delayMix: 12, delayDiv: 3, reverbMix: 12 },
  },
  {
    id: "commit-to-curiosity",
    name: "commit-to-curiosity",
    description: "Four bars in D minor that build one pattern at a time: a sparse intro, the groove, a rising question mark of a melody, and a fill that answers it. Chain mode plays A to D.",
    tempo: 108,
    swing: 30,
    chain: [0, 1, 2, 3],
    patterns: [
      {
        // A: the quiet question
        kick: "X.......x.......",
        chat: "..o...o...o...o.",
        rim: "....o.......o...",
        synth: "D2 . . . . . A1 . . . . . . . . .",
      },
      {
        // B: the groove arrives
        kick: "X.....x...X..x..",
        snare: "....X.......X...",
        clap: "............x...",
        chat: "x.ox.ox.x.ox.oxo",
        ohat: ".............x..",
        synth: "D2 . D2 . . . F2 . . . G2 . A2 . . .",
      },
      {
        // C: the curious melody, rising and left unresolved on the last step
        kick: "X.....x...X..x..",
        snare: "....X.......X...",
        chat: "x.ox.ox.x.ox.oxo",
        cowbell: "..o...o...o...o.",
        synth: "D3 F3 A3! C4 . A3 F3 . G3 A3 C4! D4 . C4 A3 E4!",
      },
      {
        // D: the fill, then the answer
        kick: "X.......x.......",
        snare: "........x.x.xxxX",
        clap: "............xxxX",
        tom: "....x.x.........",
        chat: "x.ox.ox.........",
        ohat: "..............x.",
        synth: "D2 . . . . . . . D3 . . . . . D2! .",
      },
    ],
    drums: {
      kick: { tune: 48, decay: 52, level: 92 },
      snare: { tune: 52, decay: 46, level: 72 },
      chat: { level: 44 },
      ohat: { level: 48 },
      clap: { decay: 52, level: 60 },
      tom: { tune: 55, level: 68 },
      rim: { tune: 52, level: 55 },
      cowbell: { tune: 48, decay: 30, level: 34 },
    },
    synth: { wave: 2, attack: 4, decay: 38, sustain: 18, release: 28, cutoff: 44, resonance: 38, envAmt: 58, glide: 8, level: 66 },
    fx: { comp: 52, delayDiv: 2, delayFb: 38, delayMix: 22, reverbSize: 52, reverbMix: 20 },
  },
];

export interface Preset {
  id: string;
  name: string;
  description: string;
  state: BeatState;
}

export const PRESETS: readonly Preset[] = DEFS.map((d) => {
  const state = build(d);
  assertValidState(state);
  return { id: d.id, name: d.name, description: d.description, state };
});

export const PRESET_IDS: readonly string[] = PRESETS.map((p) => p.id);

/** A fresh copy of a preset's state, or null for an unknown id. */
export function loadPreset(id: string): BeatState | null {
  const p = PRESETS.find((x) => x.id === id);
  return p ? cloneState(p.state) : null;
}

