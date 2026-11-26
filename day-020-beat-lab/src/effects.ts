// The master section: every voice feeds one bus that is split into a dry
// path, a tempo-synced feedback delay and a convolution reverb (with an
// impulse response generated here, not loaded), then squeezed by a master
// compressor and sent to an analyser and the speakers.
//
//   voices -> input --+--------------------------> compressor -> master -> analyser -> out
//                     +-> delaySend -> delay -> tone -> delayReturn -^
//                     |                   ^---- feedback <-+
//                     +-> reverbSend -> convolver -> reverbReturn -^
import { Rng, knobLinear } from "./audio-context";
import { DELAY_DIVISIONS, type FxSettings } from "./state";

/** Length of one delay repeat in seconds: a note length at the given tempo. */
export function delayTimeSeconds(tempo: number, division: number): number {
  const d = DELAY_DIVISIONS[Math.min(Math.max(Math.round(division), 0), DELAY_DIVISIONS.length - 1)];
  return (60 / tempo) * d.beats;
}

export interface CompressorSettings {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}

/** One knob drives the compressor: higher means a lower threshold and a higher ratio. */
export function compressorSettings(amount: number): CompressorSettings {
  return {
    threshold: knobLinear(amount, -10, -32),
    knee: 10,
    ratio: knobLinear(amount, 2, 12),
    attack: 0.008,
    release: 0.18,
  };
}

/** Feedback never reaches 1, so repeats always die away. */
export const MAX_FEEDBACK = 0.85;
export const feedbackGain = (k: number): number => knobLinear(k, 0, MAX_FEEDBACK);
export const wetGain = (k: number): number => knobLinear(k, 0, 1);
export const masterGain = (k: number): number => Math.pow(knobLinear(k, 0, 1), 2);
export const reverbSeconds = (size: number): number => knobLinear(size, 0.4, 3.5);

/**
 * A synthetic room: stereo noise that fades in over a couple of milliseconds,
 * decays exponentially to about -60 dB at the end, and gets darker as it
 * decays, like air absorbing high frequencies.
 */
export function generateImpulseResponse(sampleRate: number, seconds: number, seed = 99): Float32Array[] {
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const fade = Math.max(1, Math.floor(sampleRate * 0.002));
  return [seed, seed + 7].map((s) => {
    const rng = new Rng(s);
    const out = new Float32Array(length);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const decay = Math.exp(-6.9 * t);
      const coef = 0.85 - 0.7 * t; // one-pole low-pass that closes over time
      lp += (rng.signed() - lp) * coef;
      out[i] = lp * decay * Math.min(1, i / fade);
    }
    return out;
  });
}

export function createReverbBuffer(ctx: BaseAudioContext, size: number, seed?: number): AudioBuffer {
  const channels = generateImpulseResponse(ctx.sampleRate, reverbSeconds(size), seed);
  const buf = ctx.createBuffer(2, channels[0].length, ctx.sampleRate);
  channels.forEach((data, ch) => buf.getChannelData(ch).set(data));
  return buf;
}

/** Time constant for smoothing knob moves so they never click. */
const SMOOTH = 0.02;

export class Effects {
  /** Every voice connects here. */
  readonly input: GainNode;
  readonly analyser: AnalyserNode;
  readonly compressor: DynamicsCompressorNode;
  private readonly master: GainNode;
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly delayReturn: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly reverbReturn: GainNode;
  private reverbSize = -1;
  private built = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    fx: FxSettings,
    tempo: number,
    private readonly seed = 99,
  ) {
    this.input = ctx.createGain();
    this.compressor = ctx.createDynamicsCompressor();
    this.master = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    const delaySend = ctx.createGain();
    this.delay = ctx.createDelay(4);
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 3500;
    this.feedback = ctx.createGain();
    this.delayReturn = ctx.createGain();
    this.reverb = ctx.createConvolver();
    const reverbSend = ctx.createGain();
    this.reverbReturn = ctx.createGain();

    this.input.connect(this.compressor);
    this.input.connect(delaySend);
    delaySend.connect(this.delay);
    this.delay.connect(tone);
    tone.connect(this.feedback);
    this.feedback.connect(this.delay);
    tone.connect(this.delayReturn);
    this.delayReturn.connect(this.compressor);
    this.input.connect(reverbSend);
    reverbSend.connect(this.reverb);
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.apply(fx, tempo);
    this.built = true;
  }

  private set(param: AudioParam, value: number): void {
    if (this.built) param.setTargetAtTime(value, this.ctx.currentTime, SMOOTH);
    else param.value = value;
  }

  /** Push the current settings into the graph. Call again whenever a knob or the tempo changes. */
  apply(fx: FxSettings, tempo: number): void {
    const c = compressorSettings(fx.comp);
    this.set(this.compressor.threshold, c.threshold);
    this.set(this.compressor.knee, c.knee);
    this.set(this.compressor.ratio, c.ratio);
    this.set(this.compressor.attack, c.attack);
    this.set(this.compressor.release, c.release);
    this.set(this.delay.delayTime, delayTimeSeconds(tempo, fx.delayDiv));
    this.set(this.feedback.gain, feedbackGain(fx.delayFb));
    this.set(this.delayReturn.gain, wetGain(fx.delayMix));
    this.set(this.reverbReturn.gain, wetGain(fx.reverbMix));
    this.set(this.master.gain, masterGain(fx.master));
    if (fx.reverbSize !== this.reverbSize) {
      this.reverbSize = fx.reverbSize;
      this.reverb.buffer = createReverbBuffer(this.ctx, fx.reverbSize, this.seed);
    }
  }
}
