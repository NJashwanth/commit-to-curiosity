import type { Cpu } from "./cpu";

/** CHIP-8 timers and the display both run at 60Hz. */
export const TIMER_HZ = 60;
export const DEFAULT_CYCLES_PER_FRAME = 15;
export const MAX_CYCLES_PER_FRAME = 2000;
/** After a long pause (a background tab), catch up at most this many frames. */
export const MAX_CATCH_UP_FRAMES = 4;

/**
 * Turns elapsed wall-clock time into whole 60Hz frames. The remainder carries
 * over, so a 144Hz or 30Hz display still produces exactly 60 frames a second.
 * Time is kept as milliseconds x 60 so one second is exactly 60 frames, with
 * no floating point drift.
 */
export class FrameClock {
  private acc = 0;

  constructor(readonly maxFrames = MAX_CATCH_UP_FRAMES) {}

  advance(ms: number): number {
    if (!(ms > 0)) return 0;
    this.acc += ms * TIMER_HZ;
    // The epsilon absorbs float error, e.g. 60 callbacks of 1000/60 ms.
    let frames = Math.floor((this.acc + 1e-6) / 1000);
    this.acc -= frames * 1000;
    if (frames > this.maxFrames) {
      frames = this.maxFrames;
      this.acc = 0;
    }
    return frames;
  }

  reset(): void {
    this.acc = 0;
  }
}

/**
 * Drives a CPU in frames: up to `cyclesPerFrame` instructions, then one
 * 60Hz timer tick. CPU speed and timer rate are independent, so a game's
 * delays last the same wall-clock time at any speed setting.
 */
export class Machine {
  readonly clock = new FrameClock();
  /** Instructions already run in the current frame. Stepping can stop mid-frame. */
  cycleInFrame = 0;
  frameCount = 0;
  private cpf = DEFAULT_CYCLES_PER_FRAME;

  constructor(
    readonly cpu: Cpu,
    cyclesPerFrame = DEFAULT_CYCLES_PER_FRAME,
  ) {
    this.cyclesPerFrame = cyclesPerFrame;
  }

  get cyclesPerFrame(): number {
    return this.cpf;
  }

  /** Clamped to 1..MAX_CYCLES_PER_FRAME and rounded. */
  set cyclesPerFrame(n: number) {
    this.cpf = Math.min(MAX_CYCLES_PER_FRAME, Math.max(1, Math.round(n) || 1));
  }

  /** Feed elapsed wall-clock time. Runs every whole frame it covers and returns how many. */
  advance(ms: number): number {
    const frames = this.clock.advance(ms);
    for (let k = 0; k < frames; k++) this.runFrame();
    return frames;
  }

  /**
   * Run the rest of this frame's instructions, then tick the timers. A CPU
   * stalled on a key or vblank sits out the rest of the frame.
   * Returns the number of instructions executed.
   */
  runFrame(): number {
    let executed = 0;
    while (this.cycleInFrame < this.cpf && !this.cpu.blocked) {
      this.cpu.step();
      this.cycleInFrame++;
      executed++;
    }
    this.endFrame();
    return executed;
  }

  /**
   * Execute exactly one instruction (the debugger's Step). Ends the frame when
   * its cycle budget is used up or the CPU stalls, so timers keep their pace.
   */
  stepInstruction(): void {
    this.cpu.step();
    this.cycleInFrame++;
    if (this.cycleInFrame >= this.cpf || this.cpu.blocked) this.endFrame();
  }

  reset(): void {
    this.cycleInFrame = 0;
    this.frameCount = 0;
    this.clock.reset();
  }

  private endFrame(): void {
    this.cpu.tickTimers();
    this.cycleInFrame = 0;
    this.frameCount++;
  }
}
