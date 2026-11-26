// Offline export: the same engine as live playback, run on an
// OfflineAudioContext that renders faster than real time into a buffer.
import { BeatEngine } from "./engine";
import { Sequencer, type TriggerEvent } from "./sequencer";
import { STEPS_PER_BEAT, stepDuration, stepTime } from "./scheduler";
import { cloneState, type BeatState } from "./state";
import { encodeWav } from "./wav";

export const BEATS_PER_BAR = 4;

export interface SongStep {
  time: number;
  duration: number;
  /** Position in the pattern. */
  step: number;
  /** Which pattern slot is playing. */
  pattern: number;
  events: TriggerEvent[];
}

/**
 * Lay out `bars` bars of 4/4 from time 0: which sounds start when, following
 * pattern lengths, swing and the chain exactly as live playback does.
 */
export function planSong(state: BeatState, bars: number): { steps: SongStep[]; seconds: number } {
  const seq = new Sequencer(cloneState(state));
  seq.start();
  const total = bars * BEATS_PER_BAR * STEPS_PER_BEAT;
  const steps: SongStep[] = [];
  let cursor = 0;
  for (let i = 0; i < total; i++) {
    if (cursor >= seq.playLength) {
      cursor = 0;
      seq.advance();
    }
    steps.push({
      time: stepTime(0, i, state.tempo, state.swing),
      duration: stepDuration(state.tempo),
      step: cursor,
      pattern: seq.playPattern,
      events: seq.eventsAt(cursor),
    });
    cursor++;
  }
  return { steps, seconds: total * stepDuration(state.tempo) };
}

export interface RenderOptions {
  bars?: number;
  /** Extra seconds after the last step so delay and reverb tails ring out. */
  tail?: number;
  sampleRate?: number;
  createContext?: (channels: number, length: number, sampleRate: number) => OfflineAudioContext;
}

export interface Rendered {
  channels: Float32Array[];
  sampleRate: number;
  seconds: number;
}

const defaultContext = (channels: number, length: number, sampleRate: number) => new OfflineAudioContext(channels, length, sampleRate);

export async function renderBeat(state: BeatState, opts: RenderOptions = {}): Promise<Rendered> {
  const { bars = 4, tail = 1.5, sampleRate = 44100, createContext = defaultContext } = opts;
  const plan = planSong(state, bars);
  const seconds = plan.seconds + tail;
  const ctx = createContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const seq = new Sequencer(cloneState(state));
  const engine = new BeatEngine(ctx, seq);
  for (const s of plan.steps) for (const ev of s.events) engine.trigger(ev, s.time, s.duration);
  const buffer = await ctx.startRendering();
  engine.dispose();
  return {
    channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => Float32Array.from(buffer.getChannelData(c))),
    sampleRate: buffer.sampleRate,
    seconds: buffer.length / buffer.sampleRate,
  };
}

/** Render a beat and encode it as a 16-bit WAV file. */
export async function renderWav(state: BeatState, opts: RenderOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const r = await renderBeat(state, opts);
  return encodeWav(r.channels, r.sampleRate);
}
