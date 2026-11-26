// A lookahead scheduler driven by the audio clock.
//
// A JavaScript timer is only used to wake the scheduler up. It is late by a
// few milliseconds, jittery, and throttled in background tabs, so it never
// decides *when* a sound plays. Each wake-up asks the audio clock what time
// it is, and every step that falls inside the next `lookahead` seconds is
// handed to Web Audio with an exact start time. The audio thread then plays
// it sample-accurately, however late the timer woke up.
//
//   audio clock:  now ----------------------> now + lookahead
//   steps:        |  step n  |  step n+1  |  step n+2 (outside: not yet scheduled)
//   timer wakes every ~25 ms, so each step is scheduled several times ahead of time.
import { clamp } from "./audio-context";

export const MIN_TEMPO = 60;
export const MAX_TEMPO = 200;
export const MAX_SWING = 75;
export const STEPS_PER_BEAT = 4; // steps are sixteenth notes

/** Length of one step (a sixteenth note) in seconds. */
export const stepDuration = (tempo: number): number => 60 / clamp(tempo, MIN_TEMPO, MAX_TEMPO) / STEPS_PER_BEAT;

/**
 * Swing pushes every off-beat step (the 2nd, 4th, 6th, ... of the 16th-note
 * grid) later by `swing` percent of a step. On-beat steps never move.
 */
export function swingOffset(step: number, tempo: number, swing: number): number {
  if (step % 2 === 0) return 0;
  return (clamp(swing, 0, MAX_SWING) / 100) * stepDuration(tempo);
}

/** Time of step number `index` counted from `gridStart` at a fixed tempo. */
export function stepTime(gridStart: number, index: number, tempo: number, swing: number): number {
  return gridStart + index * stepDuration(tempo) + swingOffset(index, tempo, swing);
}

export interface StepEvent {
  /** Position inside the current pattern, 0-based. */
  step: number;
  /** Audio-clock time to start the sounds at. */
  time: number;
  /** Length of this step in seconds. */
  duration: number;
  /** Steps scheduled since start(), never reset by pattern loops. */
  index: number;
}

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SchedulerOptions {
  clock: { readonly currentTime: number };
  getTempo: () => number;
  getSwing: () => number;
  getLength: () => number;
  onStep: (e: StepEvent) => void;
  /** Called when the pattern loops back to step 0. */
  onWrap?: () => void;
  /** Seconds ahead of the clock to schedule. */
  lookahead?: number;
  /** Milliseconds between wake-ups. */
  interval?: number;
  /** Seconds between start() and the first step. */
  startDelay?: number;
  /** If the next step is further behind the clock than this, skip ahead instead of bursting. */
  maxLag?: number;
  timer?: TimerApi;
}

const realTimer: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class Scheduler {
  readonly lookahead: number;
  readonly interval: number;
  private readonly startDelay: number;
  private readonly maxLag: number;
  private readonly timer: TimerApi;
  private handle: unknown = null;
  private running = false;
  /** Grid time of the next step, before swing. */
  private base = 0;
  private cursor = 0;
  private count = 0;
  /** How many times the scheduler fell too far behind and skipped ahead. */
  resyncs = 0;

  constructor(private readonly o: SchedulerOptions) {
    this.lookahead = o.lookahead ?? 0.15;
    this.interval = o.interval ?? 25;
    this.startDelay = o.startDelay ?? 0.06;
    this.maxLag = o.maxLag ?? 0.25;
    this.timer = o.timer ?? realTimer;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Next pattern step to be scheduled. */
  get position(): number {
    return this.cursor;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.cursor = 0;
    this.count = 0;
    this.base = this.o.clock.currentTime + this.startDelay;
    this.tick();
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) this.timer.clear(this.handle);
    this.handle = null;
  }

  private arm(): void {
    this.handle = this.timer.set(() => {
      if (!this.running) return;
      this.tick();
      this.arm();
    }, this.interval);
  }

  /** Schedule every step that starts inside the lookahead window. Returns how many. */
  tick(): number {
    const now = this.o.clock.currentTime;
    const horizon = now + this.lookahead;
    if (this.base < now - this.maxLag) {
      this.base = now + 0.01;
      this.resyncs++;
    }
    let emitted = 0;
    for (;;) {
      let length = this.o.getLength();
      if (this.cursor >= length) {
        this.cursor = 0;
        this.o.onWrap?.();
        length = this.o.getLength();
      }
      const tempo = this.o.getTempo();
      const time = this.base + swingOffset(this.cursor, tempo, this.o.getSwing());
      if (time >= horizon) break;
      const duration = stepDuration(tempo);
      this.o.onStep({ step: this.cursor, time, duration, index: this.count });
      emitted++;
      this.cursor++;
      this.count++;
      this.base += duration;
    }
    return emitted;
  }
}
