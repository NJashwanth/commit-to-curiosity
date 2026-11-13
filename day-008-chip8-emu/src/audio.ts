const FREQUENCY_HZ = 440;
const VOLUME = 0.06;
/** Seconds for the gain to settle. Avoids clicks at the start and end of a beep. */
const RAMP = 0.005;

type AudioContextFactory = () => AudioContext;

/**
 * A square-wave beep that plays while the sound timer is above zero. Browsers
 * only allow audio after a user gesture, so the AudioContext is created by
 * unlock(), which the UI calls on the first click or key press.
 */
export class Beeper {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private playing = false;
  muted = false;

  constructor(private readonly createContext: AudioContextFactory = () => new AudioContext()) {}

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    try {
      const ctx = this.createContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = FREQUENCY_HZ;
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      this.ctx = ctx;
      this.gain = gain;
    } catch {
      // No Web Audio (or blocked): run silently.
    }
  }

  /** Call every frame with whether the sound timer is running. */
  set(active: boolean): void {
    const want = active && !this.muted;
    if (want === this.playing || !this.ctx || !this.gain) return;
    this.playing = want;
    this.gain.gain.setTargetAtTime(want ? VOLUME : 0, this.ctx.currentTime, RAMP);
  }

  get isPlaying(): boolean {
    return this.playing;
  }
}
