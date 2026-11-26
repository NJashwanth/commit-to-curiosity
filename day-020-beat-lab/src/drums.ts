// Eight synthesized drum voices. Nothing here is a sample: each hit builds a
// tiny graph of oscillators and filtered noise, shapes it with an envelope,
// and lets it garbage-collect itself after it has stopped.
import { createNoiseBuffer, Rng } from "./audio-context";

export type DrumId = "kick" | "snare" | "chat" | "ohat" | "clap" | "tom" | "rim" | "cowbell";

export const DRUM_IDS: readonly DrumId[] = ["kick", "snare", "chat", "ohat", "clap", "tom", "rim", "cowbell"];

export const DRUM_LABELS: Record<DrumId, string> = {
  kick: "Kick",
  snare: "Snare",
  chat: "Closed hat",
  ohat: "Open hat",
  clap: "Clap",
  tom: "Tom",
  rim: "Rim",
  cowbell: "Cowbell",
};

/** Every parameter is a 0..100 knob so it can be stored and shared as an integer. */
export interface DrumParams {
  tune: number;
  decay: number;
  level: number;
}

export const DRUM_DEFAULTS: Record<DrumId, DrumParams> = {
  kick: { tune: 50, decay: 50, level: 90 },
  snare: { tune: 50, decay: 50, level: 75 },
  chat: { tune: 50, decay: 40, level: 55 },
  ohat: { tune: 50, decay: 50, level: 55 },
  clap: { tune: 50, decay: 50, level: 70 },
  tom: { tune: 50, decay: 50, level: 70 },
  rim: { tune: 50, decay: 50, level: 60 },
  cowbell: { tune: 50, decay: 40, level: 50 },
};

/** Tune knob to a pitch ratio: 0 is an octave down, 50 is the voice's own pitch, 100 is an octave up. */
export const tuneRatio = (tune: number): number => Math.pow(2, (tune - 50) / 50);

/** Decay knob to an envelope length multiplier: about 0.3x at 0, 1x at 50, 3.2x at 100. */
export const decayScale = (decay: number): number => Math.pow(2, (decay - 50) / 30);

/** Level knob to gain. Squared so the lower half of the knob is useful. */
export const levelGain = (level: number): number => Math.pow(Math.min(Math.max(level, 0), 100) / 100, 2);

/** An exponential decay reaches about 0.1% after 7 time constants. */
const TAIL = 7;

interface Hit {
  ctx: BaseAudioContext;
  out: AudioNode;
  noise: AudioBuffer;
  rng: Rng;
  t: number;
  ratio: number;
  decay: number;
  gain: number;
}

interface Voice {
  /** Where the hit's envelope sits, so a choke can silence it. */
  gain: GainNode;
  /** Time the voice has fully died away. */
  end: number;
}

type VoiceFn = (h: Hit) => Voice;

function env(h: Hit, peak: number, tau: number, start = h.t): GainNode {
  const g = h.ctx.createGain();
  g.gain.setValueAtTime(peak, start);
  g.gain.setTargetAtTime(0, start, tau);
  return g;
}

function noiseSrc(h: Hit, start: number, dur: number): AudioBufferSourceNode {
  const src = h.ctx.createBufferSource();
  src.buffer = h.noise;
  src.loop = true;
  src.start(start, h.rng.next() * (h.noise.duration - 0.5));
  src.stop(start + dur);
  return src;
}

function osc(h: Hit, type: OscillatorType, freq: number, dur: number): OscillatorNode {
  const o = h.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, h.t);
  o.start(h.t);
  o.stop(h.t + dur);
  return o;
}

function filter(h: Hit, type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
  const f = h.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** Pitch-swept sine plus a short click: the classic 808-style kick. */
const kick: VoiceFn = (h) => {
  const base = 50 * h.ratio;
  const tau = 0.09 * h.decay;
  const dur = tau * TAIL;
  const body = osc(h, "sine", base * 4.5, dur);
  body.frequency.exponentialRampToValueAtTime(base, h.t + 0.11);
  const amp = env(h, h.gain, tau);
  body.connect(amp).connect(h.out);

  const click = noiseSrc(h, h.t, 0.03);
  const hp = filter(h, "highpass", 2500);
  const clickAmp = env(h, h.gain * 0.35, 0.004);
  click.connect(hp).connect(clickAmp).connect(h.out);
  return { gain: amp, end: h.t + dur };
};

/** Noise for the snares plus a triangle tone for the shell. */
const snare: VoiceFn = (h) => {
  const tau = 0.055 * h.decay;
  const dur = tau * TAIL;
  const n = noiseSrc(h, h.t, dur);
  const hp = filter(h, "highpass", 1400 * h.ratio);
  const nAmp = env(h, h.gain * 0.8, tau);
  n.connect(hp).connect(nAmp).connect(h.out);

  const tone = osc(h, "triangle", 210 * h.ratio, dur);
  tone.frequency.exponentialRampToValueAtTime(150 * h.ratio, h.t + 0.08);
  const tAmp = env(h, h.gain * 0.6, 0.035 * h.decay);
  tone.connect(tAmp).connect(h.out);
  return { gain: nAmp, end: h.t + dur };
};

function hat(tauBase: number): VoiceFn {
  return (h) => {
    const tau = tauBase * h.decay;
    const dur = tau * TAIL;
    const n = noiseSrc(h, h.t, dur);
    const hp = filter(h, "highpass", 7000 * h.ratio);
    const bp = filter(h, "bandpass", 10500 * h.ratio, 0.8);
    const amp = env(h, h.gain * 0.7, tau);
    n.connect(hp).connect(bp).connect(amp).connect(h.out);
    return { gain: amp, end: h.t + dur };
  };
}

/** Three quick noise bursts a few milliseconds apart, then a longer tail. */
const clap: VoiceFn = (h) => {
  const spacing = 0.011;
  const tail = 0.055 * h.decay;
  let last: GainNode | null = null;
  for (let i = 0; i < 4; i++) {
    const start = h.t + i * spacing;
    const isTail = i === 3;
    const tau = isTail ? tail : 0.0035;
    const n = noiseSrc(h, start, tau * TAIL);
    const bp = filter(h, "bandpass", 1150 * h.ratio, 1.4);
    last = env(h, h.gain * (isTail ? 0.9 : 0.7), tau, start);
    n.connect(bp).connect(last).connect(h.out);
  }
  return { gain: last!, end: h.t + 3 * spacing + tail * TAIL };
};

const tom: VoiceFn = (h) => {
  const base = 110 * h.ratio;
  const tau = 0.14 * h.decay;
  const dur = tau * TAIL;
  const o = osc(h, "sine", base * 1.9, dur);
  o.frequency.exponentialRampToValueAtTime(base, h.t + 0.12);
  const amp = env(h, h.gain, tau);
  o.connect(amp).connect(h.out);
  return { gain: amp, end: h.t + dur };
};

/** Two short tones and a click of noise: a rimshot. */
const rim: VoiceFn = (h) => {
  const tau = 0.012 * h.decay;
  const dur = tau * TAIL;
  const amp = env(h, h.gain * 0.7, tau);
  osc(h, "triangle", 1650 * h.ratio, dur).connect(amp);
  osc(h, "sine", 480 * h.ratio, dur).connect(amp);
  amp.connect(h.out);

  const n = noiseSrc(h, h.t, 0.02);
  const hp = filter(h, "highpass", 4500);
  const nAmp = env(h, h.gain * 0.3, 0.004);
  n.connect(hp).connect(nAmp).connect(h.out);
  return { gain: amp, end: h.t + dur };
};

/** The 808 cowbell: two detuned squares through a band-pass. */
const cowbell: VoiceFn = (h) => {
  const tau = 0.07 * h.decay;
  const dur = tau * TAIL;
  const bp = filter(h, "bandpass", 2640 * h.ratio, 1.2);
  osc(h, "square", 540 * h.ratio, dur).connect(bp);
  osc(h, "square", 800 * h.ratio, dur).connect(bp);
  const amp = env(h, h.gain * 0.45, tau);
  bp.connect(amp).connect(h.out);
  return { gain: amp, end: h.t + dur };
};

const VOICES: Record<DrumId, VoiceFn> = {
  kick,
  snare,
  chat: hat(0.012),
  ohat: hat(0.11),
  clap,
  tom,
  rim,
  cowbell,
};

/** How fast a choked hat is silenced. */
export const CHOKE_TAU = 0.003;

export class DrumKit {
  private readonly noise: AudioBuffer;
  private readonly rng: Rng;
  /** The open hat that may still be ringing, so a closed hat can choke it. */
  openHat: Voice | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    seed = 1234,
  ) {
    this.noise = createNoiseBuffer(ctx, 2, seed);
    this.rng = new Rng(seed + 1);
  }

  /** Cut the ringing open hat at time t, if it is still sounding then. */
  choke(t: number): boolean {
    const v = this.openHat;
    if (!v || t >= v.end) return false;
    v.gain.gain.setTargetAtTime(0, t, CHOKE_TAU);
    this.openHat = null;
    return true;
  }

  /**
   * Play one hit at audio-clock time `time`. `velGain` is the step's velocity
   * and accent already turned into a gain (1 is a normal hit).
   */
  trigger(id: DrumId, time: number, params: DrumParams, velGain = 1): void {
    const voice = VOICES[id];
    if (!voice) throw new Error(`Unknown drum "${id}"`);
    if (id === "chat" || id === "ohat") this.choke(time);
    const hit: Hit = {
      ctx: this.ctx,
      out: this.out,
      noise: this.noise,
      rng: this.rng,
      t: time,
      ratio: tuneRatio(params.tune),
      decay: decayScale(params.decay),
      gain: levelGain(params.level) * velGain,
    };
    const v = voice(hit);
    if (id === "ohat") this.openHat = v;
  }
}
