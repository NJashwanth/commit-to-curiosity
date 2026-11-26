// The whole beat as plain data. Everything a link or a saved slot needs to
// recreate a beat lives in BeatState, and every field is a small integer
// (knobs are 0..100) so it can be saved, shared and compared exactly.
import { DRUM_DEFAULTS, DRUM_IDS, type DrumId, type DrumParams } from "./drums";
import { MAX_SWING, MAX_TEMPO, MIN_TEMPO } from "./scheduler";
import { SYNTH_DEFAULTS, WAVES, type SynthParams } from "./synth";

export const STEP_COUNT = 32;
export const PATTERN_COUNT = 4;
export const LENGTHS = [8, 16, 32] as const;
export type PatternLength = (typeof LENGTHS)[number];
export const DRUM_TRACKS = DRUM_IDS.length; // 8
export const SYNTH_TRACK = DRUM_TRACKS; // track index 8
export const TRACK_COUNT = DRUM_TRACKS + 1;
export const MAX_CHAIN = 8;

/** Velocity is 1..16; an unaccented step defaults to 12. */
export const VEL_MAX = 16;
export const VEL_DEFAULT = 12;
export const NOTE_DEFAULT = 48; // C3
export const NOTE_MAX = 127;
export const STATE_VERSION = 1;

/** Delay times as note lengths, in beats (a beat is a quarter note). */
export const DELAY_DIVISIONS = [
  { label: "1/16", beats: 0.25 },
  { label: "1/8", beats: 0.5 },
  { label: "1/8.", beats: 0.75 },
  { label: "1/4", beats: 1 },
  { label: "1/4.", beats: 1.5 },
  { label: "1/2", beats: 2 },
] as const;

export interface DrumStep {
  on: boolean;
  vel: number;
  accent: boolean;
}
export interface SynthStep extends DrumStep {
  note: number;
}

export interface Pattern {
  length: PatternLength;
  drums: DrumStep[][]; // [DRUM_TRACKS][STEP_COUNT]
  synth: SynthStep[]; // [STEP_COUNT]
}

export interface TrackSettings extends DrumParams {
  mute: boolean;
  solo: boolean;
}
export interface SynthSettings extends SynthParams {
  mute: boolean;
  solo: boolean;
}

export interface FxSettings {
  /** Master compressor amount: 0 is gentle, 100 is heavy. */
  comp: number;
  /** Index into DELAY_DIVISIONS. */
  delayDiv: number;
  delayFb: number;
  delayMix: number;
  reverbSize: number;
  reverbMix: number;
  master: number;
}

export const FX_DEFAULTS: FxSettings = { comp: 40, delayDiv: 2, delayFb: 35, delayMix: 20, reverbSize: 45, reverbMix: 18, master: 80 };

export interface BeatState {
  version: number;
  tempo: number;
  swing: number;
  /** The pattern slot being edited, and played when chain mode is off. */
  current: number;
  chainMode: boolean;
  /** Pattern slots played in order, looping, when chain mode is on. */
  chain: number[];
  patterns: Pattern[];
  tracks: TrackSettings[];
  synth: SynthSettings;
  fx: FxSettings;
}

export const emptyDrumStep = (): DrumStep => ({ on: false, vel: VEL_DEFAULT, accent: false });
export const emptySynthStep = (): SynthStep => ({ ...emptyDrumStep(), note: NOTE_DEFAULT });

export function emptyPattern(length: PatternLength = 16): Pattern {
  return {
    length,
    drums: Array.from({ length: DRUM_TRACKS }, () => Array.from({ length: STEP_COUNT }, emptyDrumStep)),
    synth: Array.from({ length: STEP_COUNT }, emptySynthStep),
  };
}

export function createDefaultState(): BeatState {
  return {
    version: STATE_VERSION,
    tempo: 100,
    swing: 0,
    current: 0,
    chainMode: false,
    chain: [],
    patterns: Array.from({ length: PATTERN_COUNT }, () => emptyPattern()),
    tracks: DRUM_IDS.map((id: DrumId) => ({ ...DRUM_DEFAULTS[id], mute: false, solo: false })),
    synth: { ...SYNTH_DEFAULTS, mute: false, solo: false },
    fx: { ...FX_DEFAULTS },
  };
}

export const cloneState = (s: BeatState): BeatState => JSON.parse(JSON.stringify(s)) as BeatState;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check a value (parsed JSON, a decoded link, a preset) is a well-formed
 * BeatState. Returns a list of problems; an empty list means it is valid.
 * Steps that are off must be in their default form, so one beat has exactly
 * one representation and links round-trip exactly.
 */
export function validateState(input: unknown): string[] {
  const errors: string[] = [];
  const bad = (msg: string) => errors.push(msg);
  const int = (path: string, v: unknown, lo: number, hi: number) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) bad(`${path} must be an integer from ${lo} to ${hi}`);
  };
  const bool = (path: string, v: unknown) => {
    if (typeof v !== "boolean") bad(`${path} must be true or false`);
  };

  if (!isObj(input)) return ["state must be an object"];
  const s = input;
  if (s.version !== STATE_VERSION) bad(`version must be ${STATE_VERSION}`);
  int("tempo", s.tempo, MIN_TEMPO, MAX_TEMPO);
  int("swing", s.swing, 0, MAX_SWING);
  int("current", s.current, 0, PATTERN_COUNT - 1);
  bool("chainMode", s.chainMode);

  if (!Array.isArray(s.chain) || s.chain.length > MAX_CHAIN) bad(`chain must be a list of at most ${MAX_CHAIN} pattern slots`);
  else s.chain.forEach((c, i) => int(`chain[${i}]`, c, 0, PATTERN_COUNT - 1));

  const checkStep = (path: string, st: unknown, synth: boolean) => {
    if (!isObj(st)) return bad(`${path} must be an object`);
    bool(`${path}.on`, st.on);
    bool(`${path}.accent`, st.accent);
    int(`${path}.vel`, st.vel, 1, VEL_MAX);
    if (synth) int(`${path}.note`, st.note, 0, NOTE_MAX);
    if (st.on === false && (st.accent !== false || st.vel !== VEL_DEFAULT || (synth && st.note !== NOTE_DEFAULT))) {
      bad(`${path} is off, so it must use the default velocity, accent and note`);
    }
  };

  if (!Array.isArray(s.patterns) || s.patterns.length !== PATTERN_COUNT) bad(`patterns must have ${PATTERN_COUNT} slots`);
  else {
    s.patterns.forEach((p, pi) => {
      const at = `patterns[${pi}]`;
      if (!isObj(p)) return bad(`${at} must be an object`);
      if (!(LENGTHS as readonly unknown[]).includes(p.length)) bad(`${at}.length must be 8, 16 or 32`);
      if (!Array.isArray(p.drums) || p.drums.length !== DRUM_TRACKS) bad(`${at}.drums must have ${DRUM_TRACKS} tracks`);
      else
        p.drums.forEach((row: unknown, ti: number) => {
          if (!Array.isArray(row) || row.length !== STEP_COUNT) return bad(`${at}.drums[${ti}] must have ${STEP_COUNT} steps`);
          row.forEach((st, si) => checkStep(`${at}.drums[${ti}][${si}]`, st, false));
        });
      if (!Array.isArray(p.synth) || p.synth.length !== STEP_COUNT) bad(`${at}.synth must have ${STEP_COUNT} steps`);
      else p.synth.forEach((st, si) => checkStep(`${at}.synth[${si}]`, st, true));
    });
  }

  const knobs = (path: string, o: unknown, keys: Record<string, number>) => {
    if (!isObj(o)) return bad(`${path} must be an object`);
    for (const [k, max] of Object.entries(keys)) int(`${path}.${k}`, o[k], 0, max);
  };
  if (!Array.isArray(s.tracks) || s.tracks.length !== DRUM_TRACKS) bad(`tracks must have ${DRUM_TRACKS} entries`);
  else
    s.tracks.forEach((t, i) => {
      knobs(`tracks[${i}]`, t, { tune: 100, decay: 100, level: 100 });
      if (isObj(t)) {
        bool(`tracks[${i}].mute`, t.mute);
        bool(`tracks[${i}].solo`, t.solo);
      }
    });
  knobs("synth", s.synth, {
    wave: WAVES.length - 1,
    attack: 100,
    decay: 100,
    sustain: 100,
    release: 100,
    cutoff: 100,
    resonance: 100,
    envAmt: 100,
    glide: 100,
    level: 100,
  });
  if (isObj(s.synth)) {
    bool("synth.mute", s.synth.mute);
    bool("synth.solo", s.synth.solo);
  }
  knobs("fx", s.fx, { comp: 100, delayDiv: DELAY_DIVISIONS.length - 1, delayFb: 100, delayMix: 100, reverbSize: 100, reverbMix: 100, master: 100 });
  return errors;
}

export class InvalidStateError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid beat: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; and ${problems.length - 3} more` : ""}`);
    this.name = "InvalidStateError";
  }
}

export function assertValidState(s: unknown): asserts s is BeatState {
  const problems = validateState(s);
  if (problems.length) throw new InvalidStateError(problems);
}
