// Wires the pieces together: the sequencer's events become drum hits and synth
// notes on one audio context, scheduled by the lookahead scheduler. The same
// BeatEngine drives live playback and the offline WAV render.
import { createAudioContext, ensureRunning } from "./audio-context";
import { DRUM_IDS, DrumKit } from "./drums";
import { Effects } from "./effects";
import { Scheduler, type StepEvent, type TimerApi } from "./scheduler";
import { Sequencer, type TriggerEvent } from "./sequencer";
import { SynthVoice } from "./synth";

/** A synth note is held for this share of a step, so repeated notes stay separate. */
export const GATE_RATIO = 0.9;

export class BeatEngine {
  readonly effects: Effects;
  private readonly kit: DrumKit;
  private readonly synth: SynthVoice;
  private readonly unsubscribe: () => void;

  constructor(
    ctx: BaseAudioContext,
    private readonly seq: Sequencer,
  ) {
    this.effects = new Effects(ctx, seq.state.fx, seq.state.tempo);
    this.kit = new DrumKit(ctx, this.effects.input);
    this.synth = new SynthVoice(ctx, this.effects.input);
    // Knob and tempo changes reach the effects chain straight away.
    this.unsubscribe = seq.subscribe(() => this.effects.apply(seq.state.fx, seq.state.tempo));
  }

  /** Play one sequencer event at audio-clock time `time`. */
  trigger(ev: TriggerEvent, time: number, stepSeconds: number): void {
    const { state } = this.seq;
    if (ev.drum !== undefined) {
      this.kit.trigger(ev.drum, time, state.tracks[ev.track], ev.gain);
    } else if (ev.note !== undefined) {
      this.synth.noteOn(time, ev.note, stepSeconds * GATE_RATIO, state.synth, ev.gain);
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}

/** What the UI needs to draw the playhead: which step sounds at which time. */
export interface PlayheadEvent {
  step: number;
  time: number;
  pattern: number;
}

export class Player {
  private readonly scheduler: Scheduler;
  private readonly listeners = new Set<(e: PlayheadEvent) => void>();

  constructor(
    clock: { readonly currentTime: number },
    private readonly seq: Sequencer,
    private readonly engine: BeatEngine,
    timer?: TimerApi,
  ) {
    this.scheduler = new Scheduler({
      clock,
      timer,
      getTempo: () => seq.state.tempo,
      getSwing: () => seq.state.swing,
      getLength: () => seq.playLength,
      onWrap: () => seq.advance(),
      onStep: (e: StepEvent) => this.onStep(e),
    });
  }

  private onStep(e: StepEvent): void {
    for (const ev of this.seq.eventsAt(e.step)) this.engine.trigger(ev, e.time, e.duration);
    const playhead: PlayheadEvent = { step: e.step, time: e.time, pattern: this.seq.playPattern };
    for (const fn of this.listeners) fn(playhead);
  }

  get isPlaying(): boolean {
    return this.scheduler.isRunning;
  }

  onPlayhead(fn: (e: PlayheadEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.scheduler.isRunning) return;
    this.seq.start();
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }
}

export interface AudioAppOptions {
  createContext?: () => AudioContext;
  timer?: TimerApi;
}

/**
 * Owns the audio context. Browsers only allow audio after a user gesture, so
 * the context, engine and player are created lazily by the first Play click.
 */
export class AudioApp {
  private ctx: AudioContext | null = null;
  private engine: BeatEngine | null = null;
  private player: Player | null = null;
  private readonly playheadListeners = new Set<(e: PlayheadEvent) => void>();

  constructor(
    readonly seq: Sequencer,
    private readonly opts: AudioAppOptions = {},
  ) {}

  /** Create the context (once) and make sure it is running. Call from a user gesture. */
  async ensure(): Promise<boolean> {
    if (!this.ctx) {
      this.ctx = (this.opts.createContext ?? createAudioContext)();
      this.engine = new BeatEngine(this.ctx, this.seq);
      this.player = new Player(this.ctx, this.seq, this.engine, this.opts.timer);
      this.player.onPlayhead((e) => this.playheadListeners.forEach((fn) => fn(e)));
    }
    return ensureRunning(this.ctx);
  }

  get playing(): boolean {
    return this.player?.isPlaying ?? false;
  }

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Output latency in seconds, so the playhead lines up with what you hear. */
  get latency(): number {
    return this.ctx ? ((this.ctx as { outputLatency?: number }).outputLatency ?? this.ctx.baseLatency ?? 0) : 0;
  }

  get analyser(): AnalyserNode | null {
    return this.engine?.effects.analyser ?? null;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  onPlayhead(fn: (e: PlayheadEvent) => void): () => void {
    this.playheadListeners.add(fn);
    return () => this.playheadListeners.delete(fn);
  }

  async play(): Promise<boolean> {
    if (!(await this.ensure())) return false;
    this.player!.start();
    return true;
  }

  stop(): void {
    this.player?.stop();
  }

  async toggle(): Promise<boolean> {
    if (this.playing) {
      this.stop();
      return false;
    }
    return this.play();
  }

  /** Play a track's first sound immediately, for auditioning a voice. */
  async audition(track: number): Promise<void> {
    if (!(await this.ensure())) return;
    const ev: TriggerEvent =
      track < 8
        ? { track, drum: DRUM_IDS[track], gain: 1, accent: false }
        : { track, note: this.seq.pattern.synth.find((s) => s.on)?.note ?? 48, gain: 1, accent: false };
    this.engine!.trigger(ev, this.ctx!.currentTime + 0.01, 0.15);
  }
}
