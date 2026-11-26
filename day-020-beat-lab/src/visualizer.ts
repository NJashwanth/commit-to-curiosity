// A spectrum analyser drawn on a canvas: log-spaced bars with a smooth fall.
// The drawing target is a tiny interface so the maths and the drawing calls
// can both be tested in Node with a fake 2D context.

export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}
export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: "2d"): Ctx2D | null;
}
export interface AnalyserLike {
  readonly frequencyBinCount: number;
  getByteFrequencyData(arr: Uint8Array<ArrayBuffer>): void;
}

/**
 * Bin boundaries for `bars` bars spaced evenly on a log frequency axis
 * between minHz and maxHz. Returns bars + 1 increasing bin indexes.
 */
export function barEdges(bars: number, binCount: number, sampleRate: number, minHz = 40, maxHz = 16000): number[] {
  const nyquist = sampleRate / 2;
  const hi = Math.min(maxHz, nyquist);
  const edges: number[] = [];
  for (let i = 0; i <= bars; i++) {
    const hz = minHz * Math.pow(hi / minHz, i / bars);
    edges.push(Math.min(binCount, Math.round((hz / nyquist) * binCount)));
  }
  // Keep every bar at least one bin wide so low bars are not empty.
  for (let i = 1; i <= bars; i++) if (edges[i] <= edges[i - 1]) edges[i] = Math.min(binCount, edges[i - 1] + 1);
  return edges;
}

/** Peak of each bar's bins, 0..1. */
export function computeBars(data: ArrayLike<number>, edges: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    let peak = 0;
    for (let b = edges[i]; b < Math.max(edges[i + 1], edges[i] + 1) && b < data.length; b++) peak = Math.max(peak, data[b]);
    out.push(peak / 255);
  }
  return out;
}

export interface VisualizerOptions {
  bars?: number;
  /** How much each bar may fall per frame, as a share of full height. */
  fall?: number;
  sampleRate?: number;
}

export class Visualizer {
  private readonly bars: number;
  private readonly fall: number;
  private levels: number[];
  private buf: Uint8Array<ArrayBuffer> | null = null;
  private edges: number[] = [];
  sampleRate: number;

  constructor(
    private readonly canvas: CanvasLike,
    private readonly getAnalyser: () => AnalyserLike | null,
    opts: VisualizerOptions = {},
  ) {
    this.bars = opts.bars ?? 48;
    this.fall = opts.fall ?? 0.04;
    this.sampleRate = opts.sampleRate ?? 44100;
    this.levels = new Array<number>(this.bars).fill(0);
  }

  /** Read the analyser, update the smoothed levels and draw one frame. Returns the levels. */
  draw(): number[] {
    const analyser = this.getAnalyser();
    let fresh: number[] = new Array<number>(this.bars).fill(0);
    if (analyser) {
      if (!this.buf || this.buf.length !== analyser.frequencyBinCount) {
        this.buf = new Uint8Array(analyser.frequencyBinCount);
        this.edges = barEdges(this.bars, analyser.frequencyBinCount, this.sampleRate);
      }
      analyser.getByteFrequencyData(this.buf);
      fresh = computeBars(this.buf, this.edges);
    }
    this.levels = this.levels.map((old, i) => Math.max(fresh[i], old - this.fall));

    const g = this.canvas.getContext("2d");
    if (!g) return this.levels;
    const { width: w, height: h } = this.canvas;
    g.clearRect(0, 0, w, h);
    const slot = w / this.bars;
    const gap = Math.max(1, slot * 0.18);
    this.levels.forEach((v, i) => {
      const bh = Math.max(1, v * h);
      g.fillStyle = `hsl(${14 + (i / this.bars) * 50}, 90%, ${48 + v * 14}%)`;
      g.fillRect(i * slot + gap / 2, h - bh, slot - gap, bh);
    });
    return this.levels;
  }
}
