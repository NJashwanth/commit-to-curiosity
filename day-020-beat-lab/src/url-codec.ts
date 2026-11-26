// Packs a whole beat into a short URL hash and back, bit by bit.
//
// Layout (all fields MSB first): version byte, tempo, swing, current slot,
// chain mode and chain, then for each pattern its length and, per track, a
// 32-bit mask of which steps are on followed by accent, velocity (and note
// for the synth) for the steps that are on only. Then every knob as 7 bits,
// and finally a 16-bit Fletcher checksum so a truncated or edited link is
// rejected instead of silently loading the wrong beat.
import { MIN_TEMPO } from "./scheduler";
import {
  LENGTHS,
  MAX_CHAIN,
  PATTERN_COUNT,
  STATE_VERSION,
  createDefaultState,
  emptyPattern,
  validateState,
  type BeatState,
  type DrumStep,
  type SynthSettings,
  type SynthStep,
} from "./state";

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function toBase64Url(bytes: ArrayLike<number>): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += ALPHABET[n & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  for (let i = 0; i < text.length; i++) {
    if (!LOOKUP.has(text[i])) throw new CodecError(`The link contains a character that is not valid here ("${text[i]}" at position ${i + 1}).`);
  }
  if (text.length % 4 === 1) throw new CodecError("The link is cut off: its length is not valid.");
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const a = LOOKUP.get(text[i])!;
    const b = LOOKUP.get(text[i + 1])!;
    const c = text[i + 2] === undefined ? undefined : LOOKUP.get(text[i + 2])!;
    const d = text[i + 3] === undefined ? undefined : LOOKUP.get(text[i + 3])!;
    out.push((a << 2) | (b >> 4));
    if (c !== undefined) out.push(((b & 15) << 4) | (c >> 2));
    if (d !== undefined) out.push(((c! & 3) << 6) | d);
  }
  return Uint8Array.from(out);
}

export function fletcher16(bytes: ArrayLike<number>): number {
  let a = 0;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 255;
    b = (b + a) % 255;
  }
  return (b << 8) | a;
}

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private n = 0;
  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(value / 2 ** i) % 2);
      if (++this.n === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.n = 0;
      }
    }
  }
  bool(b: boolean): void {
    this.write(b ? 1 : 0, 1);
  }
  finish(): number[] {
    if (this.n > 0) this.write(0, 8 - this.n);
    return this.bytes;
  }
}

class BitReader {
  private pos = 0;
  constructor(private readonly bytes: ArrayLike<number>) {}
  read(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) throw new CodecError("The link is too short: the beat data ends early.");
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  bool(): boolean {
    return this.read(1) === 1;
  }
  /** Bits left over after the data; they must be zero padding. */
  rest(): number[] {
    const out: number[] = [];
    for (; this.pos < this.bytes.length * 8; this.pos++) out.push((this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
    return out;
  }
}

const SYNTH_KNOBS = ["attack", "decay", "sustain", "release", "cutoff", "resonance", "envAmt", "glide", "level"] as const;
const FX_KNOBS = ["comp", "delayFb", "delayMix", "reverbSize", "reverbMix", "master"] as const;

/** Encode a state as base64url text. The state must be valid. */
export function encodeState(state: BeatState): string {
  const problems = validateState(state);
  if (problems.length) throw new CodecError(`Cannot share an invalid beat: ${problems[0]}.`);
  const w = new BitWriter();
  w.write(STATE_VERSION, 8);
  w.write(state.tempo - MIN_TEMPO, 8);
  w.write(state.swing, 7);
  w.write(state.current, 2);
  w.bool(state.chainMode);
  w.write(state.chain.length, 4);
  state.chain.forEach((c) => w.write(c, 2));

  const step = (st: DrumStep | SynthStep, synth: boolean) => {
    w.bool(st.accent);
    w.write(st.vel - 1, 4);
    if (synth) w.write((st as SynthStep).note, 7);
  };
  const row = (steps: (DrumStep | SynthStep)[], synth: boolean) => {
    steps.forEach((st) => w.bool(st.on));
    steps.filter((st) => st.on).forEach((st) => step(st, synth));
  };
  for (const p of state.patterns) {
    w.write(LENGTHS.indexOf(p.length), 2);
    p.drums.forEach((d) => row(d, false));
    row(p.synth, true);
  }
  for (const t of state.tracks) {
    w.write(t.tune, 7);
    w.write(t.decay, 7);
    w.write(t.level, 7);
    w.bool(t.mute);
    w.bool(t.solo);
  }
  const sy = state.synth;
  w.write(sy.wave, 2);
  SYNTH_KNOBS.forEach((k) => w.write(sy[k], 7));
  w.bool(sy.mute);
  w.bool(sy.solo);
  w.write(state.fx.comp, 7);
  w.write(state.fx.delayDiv, 3);
  FX_KNOBS.slice(1).forEach((k) => w.write(state.fx[k], 7));

  const body = w.finish();
  const sum = fletcher16(body);
  return toBase64Url([...body, sum >> 8, sum & 255]);
}

/** Decode base64url text into a validated state, or throw a CodecError that says what is wrong. */
export function decodeState(text: string): BeatState {
  if (!text) throw new CodecError("The link has no beat data in it.");
  const raw = fromBase64Url(text);
  if (raw.length < 4) throw new CodecError("The link is too short to be a beat.");
  const body = raw.subarray(0, raw.length - 2);
  const sum = (raw[raw.length - 2] << 8) | raw[raw.length - 1];
  if (fletcher16(body) !== sum) throw new CodecError("The link is damaged: its checksum does not match. It may have been cut off or edited.");

  const r = new BitReader(body);
  const version = r.read(8);
  if (version !== STATE_VERSION) throw new CodecError(`This link was made by a different version of Beat Lab (v${version}); this one understands v${STATE_VERSION}.`);

  const s = createDefaultState();
  s.tempo = r.read(8) + MIN_TEMPO;
  s.swing = r.read(7);
  s.current = r.read(2);
  s.chainMode = r.bool();
  const chainLen = r.read(4);
  if (chainLen > MAX_CHAIN) throw new CodecError(`The link has a chain of ${chainLen} patterns; the most allowed is ${MAX_CHAIN}.`);
  s.chain = Array.from({ length: chainLen }, () => r.read(2));

  const row = (steps: (DrumStep | SynthStep)[], synth: boolean) => {
    const on = steps.map(() => r.bool());
    steps.forEach((st, i) => {
      if (!on[i]) return;
      st.on = true;
      st.accent = r.bool();
      st.vel = r.read(4) + 1;
      if (synth) (st as SynthStep).note = r.read(7);
    });
  };
  s.patterns = Array.from({ length: PATTERN_COUNT }, () => {
    const p = emptyPattern(16);
    const code = r.read(2);
    if (code >= LENGTHS.length) throw new CodecError("The link has a pattern length that does not exist.");
    p.length = LENGTHS[code];
    p.drums.forEach((d) => row(d, false));
    row(p.synth, true);
    return p;
  });
  s.tracks.forEach((t) => {
    t.tune = r.read(7);
    t.decay = r.read(7);
    t.level = r.read(7);
    t.mute = r.bool();
    t.solo = r.bool();
  });
  const sy = s.synth as SynthSettings;
  sy.wave = r.read(2);
  SYNTH_KNOBS.forEach((k) => (sy[k] = r.read(7)));
  sy.mute = r.bool();
  sy.solo = r.bool();
  s.fx.comp = r.read(7);
  s.fx.delayDiv = r.read(3);
  FX_KNOBS.slice(1).forEach((k) => (s.fx[k] = r.read(7)));

  if (r.rest().some((b) => b === 1)) throw new CodecError("The link has extra data after the beat, so it is not a link this app made.");
  const problems = validateState(s);
  if (problems.length) throw new CodecError(`The link decoded to an invalid beat: ${problems[0]}.`);
  return s;
}

export const HASH_PREFIX = "b=";

/** `#b=...` for a location hash. */
export const stateToHash = (state: BeatState): string => `#${HASH_PREFIX}${encodeState(state)}`;

/** Parse a location hash, with or without the leading #. Returns null when there is no beat in it. */
export function hashToState(hash: string): BeatState | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h) return null;
  if (!h.startsWith(HASH_PREFIX)) return null;
  return decodeState(h.slice(HASH_PREFIX.length));
}

