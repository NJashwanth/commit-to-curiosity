// Audio context creation plus the small bits of audio math every other module
// shares: clamping, dB and MIDI conversion, and a seeded noise generator.

export class AudioUnsupportedError extends Error {
  constructor() {
    super("This browser has no Web Audio API (AudioContext is missing).");
    this.name = "AudioUnsupportedError";
  }
}

export type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** Find the AudioContext constructor, including the old webkit-prefixed one. */
export function getAudioContextCtor(scope: Record<string, unknown> = globalThis as Record<string, unknown>): AudioContextCtor {
  const ctor = (scope.AudioContext ?? scope.webkitAudioContext) as AudioContextCtor | undefined;
  if (typeof ctor !== "function") throw new AudioUnsupportedError();
  return ctor;
}

export interface CreateOptions {
  sampleRate?: number;
  scope?: Record<string, unknown>;
}

export function createAudioContext(opts: CreateOptions = {}): AudioContext {
  const Ctor = getAudioContextCtor(opts.scope);
  const options: AudioContextOptions = { latencyHint: "interactive" };
  if (opts.sampleRate) options.sampleRate = opts.sampleRate;
  return new Ctor(options);
}

/**
 * Browsers start contexts suspended until a user gesture. Call this from a
 * click handler. Returns true when the context is running afterwards.
 */
export async function ensureRunning(ctx: Pick<AudioContext, "state" | "resume">): Promise<boolean> {
  if (ctx.state === "running") return true;
  if (ctx.state === "closed") return false;
  try {
    await ctx.resume();
  } catch {
    return false;
  }
  return (ctx.state as string) === "running";
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Map a 0..100 knob to [lo, hi] linearly. */
export const knobLinear = (k: number, lo: number, hi: number): number => lo + (clamp(k, 0, 100) / 100) * (hi - lo);

/** Map a 0..100 knob to [lo, hi] exponentially (lo and hi must be > 0). */
export const knobExp = (k: number, lo: number, hi: number): number => lo * Math.pow(hi / lo, clamp(k, 0, 100) / 100);

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(g, 1e-9));

/** Equal-tempered pitch: MIDI note 69 is A4 = 440 Hz. */
export const midiToFreq = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const midiToName = (note: number): string => `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;

/** xorshift32: tiny, fast and seedable, so noise (and offline renders) are reproducible. */
export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  /** Uniform float in [0, 1). */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  /** Uniform float in [-1, 1). */
  signed(): number {
    return this.next() * 2 - 1;
  }
}

export function noiseSamples(length: number, seed?: number): Float32Array {
  const rng = new Rng(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rng.signed();
  return out;
}

/** A mono white-noise buffer. Drums loop or slice it instead of making new noise per hit. */
export function createNoiseBuffer(ctx: BaseAudioContext, seconds = 2, seed?: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  buffer.getChannelData(0).set(noiseSamples(length, seed));
  return buffer;
}
