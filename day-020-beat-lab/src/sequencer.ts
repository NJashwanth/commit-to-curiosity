// Pattern editing and playback logic, with no audio in it: toggling steps,
// velocity and accents, mute and solo, copying patterns and chaining them.
import { clamp } from "./audio-context";
import { DRUM_IDS, type DrumId } from "./drums";
import { MAX_SWING, MAX_TEMPO, MIN_TEMPO } from "./scheduler";
import { WAVES } from "./synth";
import {
  DELAY_DIVISIONS,
  DRUM_TRACKS,
  LENGTHS,
  MAX_CHAIN,
  NOTE_DEFAULT,
  NOTE_MAX,
  PATTERN_COUNT,
  STEP_COUNT,
  SYNTH_TRACK,
  TRACK_COUNT,
  VEL_DEFAULT,
  VEL_MAX,
  assertValidState,
  cloneState,
  emptyPattern,
  type BeatState,
  type FxSettings,
  type Pattern,
  type PatternLength,
  type SynthSettings,
  type TrackSettings,
} from "./state";

export const ACCENT_BOOST = 1.4;

/** Step velocity (1..16) and accent to a gain: 16 is full, an accent is 40% louder. */
export const velocityGain = (vel: number, accent: boolean): number => Math.pow(clamp(vel, 1, VEL_MAX) / VEL_MAX, 1.5) * (accent ? ACCENT_BOOST : 1);

export interface TriggerEvent {
  /** 0..7 drum tracks, 8 the synth. */
  track: number;
  drum?: DrumId;
  /** MIDI note, synth only. */
  note?: number;
  gain: number;
  accent: boolean;
}

type Listener = (state: BeatState) => void;

export class Sequencer {
  state: BeatState;
  /** The pattern slot being played right now (differs from state.current in chain mode). */
  playPattern: number;
  private chainPos = 0;
  private listeners = new Set<Listener>();

  constructor(state: BeatState) {
    assertValidState(state);
    this.state = state;
    this.playPattern = state.current;
  }

  // ---- change notification ----

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /** Replace the whole beat (after validation), e.g. from a preset or a link. */
  load(next: BeatState): void {
    assertValidState(next);
    this.state = cloneState(next);
    this.playPattern = this.state.current;
    this.chainPos = 0;
    this.changed();
  }

  // ---- access ----

  get pattern(): Pattern {
    return this.state.patterns[this.state.current];
  }

  private checkTrack(track: number): void {
    if (!Number.isInteger(track) || track < 0 || track >= TRACK_COUNT) throw new RangeError(`Track ${track} is out of range`);
  }
  private checkStep(step: number): void {
    if (!Number.isInteger(step) || step < 0 || step >= STEP_COUNT) throw new RangeError(`Step ${step} is out of range`);
  }

  private step(track: number, step: number, pattern = this.pattern) {
    this.checkTrack(track);
    this.checkStep(step);
    return track === SYNTH_TRACK ? pattern.synth[step] : pattern.drums[track][step];
  }

  // ---- steps ----

  /** Turn a step on or off. Turning it off resets its velocity, accent and note. Returns the new state of the step. */
  toggleStep(track: number, step: number): boolean {
    const st = this.step(track, step);
    st.on = !st.on;
    if (!st.on) {
      st.vel = VEL_DEFAULT;
      st.accent = false;
      if ("note" in st) st.note = NOTE_DEFAULT;
    }
    this.changed();
    return st.on;
  }

  /** Set velocity 1..16. Setting it on an empty step switches the step on. */
  setVelocity(track: number, step: number, vel: number): void {
    const st = this.step(track, step);
    st.vel = clamp(Math.round(vel), 1, VEL_MAX);
    st.on = true;
    this.changed();
  }

  toggleAccent(track: number, step: number): boolean {
    const st = this.step(track, step);
    st.accent = !st.accent;
    st.on = true;
    this.changed();
    return st.accent;
  }

  /** Set the synth note for a step (MIDI 0..127). Setting a note switches the step on. */
  setNote(step: number, note: number): void {
    this.checkStep(step);
    const st = this.pattern.synth[step];
    st.note = clamp(Math.round(note), 0, NOTE_MAX);
    st.on = true;
    this.changed();
  }

  /** Move a step's note up or down in semitones. */
  transposeStep(step: number, semitones: number): void {
    this.checkStep(step);
    this.setNote(step, this.pattern.synth[step].note + semitones);
  }

  clearTrack(track: number): void {
    this.checkTrack(track);
    for (let i = 0; i < STEP_COUNT; i++) {
      const st = this.step(track, i);
      if (st.on) this.toggleStep(track, i);
    }
    this.changed();
  }

  // ---- track mix ----

  private mixOf(track: number): TrackSettings | SynthSettings {
    this.checkTrack(track);
    return track === SYNTH_TRACK ? this.state.synth : this.state.tracks[track];
  }

  toggleMute(track: number): boolean {
    const t = this.mixOf(track);
    t.mute = !t.mute;
    this.changed();
    return t.mute;
  }

  toggleSolo(track: number): boolean {
    const t = this.mixOf(track);
    t.solo = !t.solo;
    this.changed();
    return t.solo;
  }

  get anySolo(): boolean {
    return this.state.tracks.some((t) => t.solo) || this.state.synth.solo;
  }

  /**
   * Is the track heard? If anything is soloed only soloed tracks play (solo
   * wins over mute); otherwise every track plays unless it is muted.
   */
  isAudible(track: number): boolean {
    const t = this.mixOf(track);
    return this.anySolo ? t.solo : !t.mute;
  }

  // ---- parameters ----

  setTempo(bpm: number): void {
    this.state.tempo = clamp(Math.round(bpm), MIN_TEMPO, MAX_TEMPO);
    this.changed();
  }

  setSwing(pct: number): void {
    this.state.swing = clamp(Math.round(pct), 0, MAX_SWING);
    this.changed();
  }

  setDrumParam(track: number, key: "tune" | "decay" | "level", value: number): void {
    if (track < 0 || track >= DRUM_TRACKS) throw new RangeError(`Track ${track} is not a drum track`);
    this.state.tracks[track][key] = clamp(Math.round(value), 0, 100);
    this.changed();
  }

  setSynthParam(key: Exclude<keyof SynthSettings, "mute" | "solo">, value: number): void {
    const max = key === "wave" ? WAVES.length - 1 : 100;
    this.state.synth[key] = clamp(Math.round(value), 0, max);
    this.changed();
  }

  setFx(key: keyof FxSettings, value: number): void {
    const max = key === "delayDiv" ? DELAY_DIVISIONS.length - 1 : 100;
    this.state.fx[key] = clamp(Math.round(value), 0, max);
    this.changed();
  }

  // ---- patterns ----

  setLength(length: number, slot = this.state.current): void {
    if (!(LENGTHS as readonly number[]).includes(length)) throw new RangeError(`Pattern length must be 8, 16 or 32 (got ${length})`);
    this.state.patterns[slot].length = length as PatternLength;
    this.changed();
  }

  selectPattern(slot: number): void {
    this.checkSlot(slot);
    this.state.current = slot;
    this.changed();
  }

  private checkSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= PATTERN_COUNT) throw new RangeError(`Pattern slot ${slot} is out of range`);
  }

  /** Copy one pattern slot over another (a deep copy). */
  copyPattern(from: number, to: number): void {
    this.checkSlot(from);
    this.checkSlot(to);
    if (from === to) return;
    this.state.patterns[to] = JSON.parse(JSON.stringify(this.state.patterns[from])) as Pattern;
    this.changed();
  }

  clearPattern(slot: number): void {
    this.checkSlot(slot);
    this.state.patterns[slot] = emptyPattern(this.state.patterns[slot].length);
    this.changed();
  }

  // ---- chain ----

  setChainMode(on: boolean): void {
    this.state.chainMode = on;
    this.changed();
  }

  /** Add a slot to the end of the chain. Returns false if the chain is full. */
  appendChain(slot: number): boolean {
    this.checkSlot(slot);
    if (this.state.chain.length >= MAX_CHAIN) return false;
    this.state.chain.push(slot);
    this.changed();
    return true;
  }

  popChain(): void {
    this.state.chain.pop();
    this.changed();
  }

  clearChain(): void {
    this.state.chain = [];
    this.changed();
  }

  setChain(slots: number[]): void {
    if (slots.length > MAX_CHAIN) throw new RangeError(`A chain holds at most ${MAX_CHAIN} patterns`);
    slots.forEach((s) => this.checkSlot(s));
    this.state.chain = [...slots];
    this.changed();
  }

  // ---- playback ----

  private get chaining(): boolean {
    return this.state.chainMode && this.state.chain.length > 0;
  }

  /** Reset to the start of the song: the first chain slot, or the current pattern. */
  start(): void {
    this.chainPos = 0;
    this.playPattern = this.chaining ? this.state.chain[0] : this.state.current;
  }

  /** Called when the playing pattern loops: pick which pattern plays next. */
  advance(): number {
    if (this.chaining) {
      this.chainPos = (this.chainPos + 1) % this.state.chain.length;
      this.playPattern = this.state.chain[this.chainPos];
    } else {
      this.playPattern = this.state.current;
    }
    return this.playPattern;
  }

  get playLength(): number {
    return this.state.patterns[this.playPattern].length;
  }

  /** Every sound that starts on `step` of the playing pattern, honouring mute and solo. */
  eventsAt(step: number, slot = this.playPattern): TriggerEvent[] {
    const p = this.state.patterns[slot];
    if (step < 0 || step >= p.length) return [];
    const out: TriggerEvent[] = [];
    for (let t = 0; t < DRUM_TRACKS; t++) {
      const st = p.drums[t][step];
      if (st.on && this.isAudible(t)) out.push({ track: t, drum: DRUM_IDS[t], gain: velocityGain(st.vel, st.accent), accent: st.accent });
    }
    const sy = p.synth[step];
    if (sy.on && this.isAudible(SYNTH_TRACK)) out.push({ track: SYNTH_TRACK, note: sy.note, gain: velocityGain(sy.vel, sy.accent), accent: sy.accent });
    return out;
  }
}
