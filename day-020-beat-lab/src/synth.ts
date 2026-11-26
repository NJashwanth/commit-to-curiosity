// A monophonic subtractive synth voice: oscillator, low-pass filter, amp
// envelope, filter envelope and glide. The ADSR is piecewise linear, defined
// once as a pure function and once as a list of breakpoints, so the exact
// automation sent to Web Audio can be checked against the maths.
import { clamp, knobExp, knobLinear, midiToFreq } from "./audio-context";

export type Wave = "sine" | "square" | "sawtooth" | "triangle";
export const WAVES: readonly Wave[] = ["sine", "square", "sawtooth", "triangle"];
export const WAVE_LABELS: Record<Wave, string> = { sine: "Sine", square: "Square", sawtooth: "Saw", triangle: "Triangle" };

/** Every parameter is a 0..100 knob (wave is an index into WAVES). */
export interface SynthParams {
  wave: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  cutoff: number;
  resonance: number;
  envAmt: number;
  glide: number;
  level: number;
}

export const SYNTH_DEFAULTS: SynthParams = {
  wave: 2,
  attack: 5,
  decay: 45,
  sustain: 35,
  release: 30,
  cutoff: 45,
  resonance: 30,
  envAmt: 55,
  glide: 0,
  level: 70,
};

export const waveType = (index: number): Wave => WAVES[index] ?? "sine";

/** Envelope stages never get shorter than this, so ramps always have a duration. */
export const MIN_STAGE = 0.001;

export interface Adsr {
  attack: number; // seconds
  decay: number; // seconds
  sustain: number; // 0..1
  release: number; // seconds
}

export function adsrFromKnobs(p: Pick<SynthParams, "attack" | "decay" | "sustain" | "release">): Adsr {
  return {
    attack: knobExp(p.attack, MIN_STAGE, 1.5),
    decay: knobExp(p.decay, 0.01, 2),
    sustain: clamp(p.sustain, 0, 100) / 100,
    release: knobExp(p.release, 0.01, 2.5),
  };
}

export const cutoffHz = (k: number): number => knobExp(k, 40, 14000);
/** Low-pass Q in dB. */
export const resonanceDb = (k: number): number => knobLinear(k, 0, 22);
/** Filter envelope depth in octaves. */
export const envOctaves = (k: number): number => knobLinear(k, 0, 5);
export const glideSeconds = (k: number): number => knobLinear(k, 0, 0.35);
export const synthLevel = (k: number): number => Math.pow(clamp(k, 0, 100) / 100, 2) * 0.4;

/** The attack/decay/sustain level while the key is held, t seconds after note-on. */
function heldLevel(env: Adsr, t: number): number {
  const a = Math.max(env.attack, MIN_STAGE);
  const d = Math.max(env.decay, MIN_STAGE);
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - env.sustain) * ((t - a) / d);
  return env.sustain;
}

/**
 * Envelope level (0..1) at time t after note-on, with the key released at
 * `gate`. If the key comes up before the attack or decay has finished, the
 * release starts from wherever the level had got to.
 */
export function adsrLevel(env: Adsr, t: number, gate: number): number {
  if (t <= 0) return 0;
  if (t < gate) return heldLevel(env, t);
  const r = Math.max(env.release, MIN_STAGE);
  const from = heldLevel(env, gate);
  const since = t - gate;
  return since >= r ? 0 : from * (1 - since / r);
}

export interface Breakpoint {
  t: number;
  v: number;
}

/** The corners of the envelope as (time, level) points, joined by linear ramps. */
export function planEnvelope(env: Adsr, gate: number): Breakpoint[] {
  const a = Math.max(env.attack, MIN_STAGE);
  const d = Math.max(env.decay, MIN_STAGE);
  const r = Math.max(env.release, MIN_STAGE);
  const g = Math.max(gate, MIN_STAGE);
  const pts: Breakpoint[] = [{ t: 0, v: 0 }];
  if (g <= a) {
    pts.push({ t: g, v: g / a });
  } else {
    pts.push({ t: a, v: 1 });
    if (g <= a + d) {
      pts.push({ t: g, v: heldLevel(env, g) });
    } else {
      pts.push({ t: a + d, v: env.sustain });
      pts.push({ t: g, v: env.sustain });
    }
  }
  pts.push({ t: g + r, v: 0 });
  return pts;
}

/** Evaluate a plan by linear interpolation. Used to check plans against adsrLevel. */
export function evalPlan(plan: Breakpoint[], t: number): number {
  if (t <= plan[0].t) return plan[0].v;
  for (let i = 1; i < plan.length; i++) {
    const p = plan[i];
    if (t <= p.t) {
      const q = plan[i - 1];
      return p.t === q.t ? p.v : q.v + ((p.v - q.v) * (t - q.t)) / (p.t - q.t);
    }
  }
  return plan[plan.length - 1].v;
}

/** Send a plan to an AudioParam: level * scale + offset, starting at time t0. */
export function applyPlan(param: AudioParam, plan: Breakpoint[], t0: number, scale: number, offset = 0): void {
  param.setValueAtTime(plan[0].v * scale + offset, t0 + plan[0].t);
  for (let i = 1; i < plan.length; i++) param.linearRampToValueAtTime(plan[i].v * scale + offset, t0 + plan[i].t);
}

/** How fast the previous note is silenced when a new one takes over. */
export const CUT_TAU = 0.004;

interface Playing {
  cut: GainNode;
  end: number;
}

export class SynthVoice {
  private lastFreq: number | null = null;
  private playing: Playing | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
  ) {}

  /**
   * Schedule a note: MIDI number, held for `gate` seconds from audio-clock
   * time `time`. The synth is monophonic, so a note that starts while the
   * last one is still sounding cuts it off, and glide slides in from its pitch.
   */
  noteOn(time: number, midi: number, gate: number, p: SynthParams, velGain = 1): void {
    const { ctx } = this;
    const env = adsrFromKnobs(p);
    const plan = planEnvelope(env, gate);
    const freq = midiToFreq(midi);
    const end = time + plan[plan.length - 1].t;

    if (this.playing && time < this.playing.end) {
      this.playing.cut.gain.setTargetAtTime(0, time, CUT_TAU);
    }

    const osc = ctx.createOscillator();
    osc.type = waveType(p.wave);
    const glide = glideSeconds(p.glide);
    if (glide > 0 && this.lastFreq !== null && this.lastFreq !== freq) {
      osc.frequency.setValueAtTime(this.lastFreq, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + glide);
    } else {
      osc.frequency.setValueAtTime(freq, time);
    }

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoffHz(p.cutoff);
    filter.Q.value = resonanceDb(p.resonance);
    // Detune is in cents, so a linear ramp here is an exponential cutoff sweep.
    applyPlan(filter.detune, plan, time, envOctaves(p.envAmt) * 1200);

    const amp = ctx.createGain();
    applyPlan(amp.gain, plan, time, synthLevel(p.level) * velGain);

    const cut = ctx.createGain();
    osc.connect(filter).connect(amp).connect(cut).connect(this.out);
    osc.start(time);
    osc.stop(end + 0.05);

    this.lastFreq = freq;
    this.playing = { cut, end };
  }
}
