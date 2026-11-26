import { describe, expect, it } from "vitest";
import { Visualizer, barEdges, computeBars, type AnalyserLike, type CanvasLike, type Ctx2D } from "../src/visualizer";

class FakeCtx implements Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  cleared = 0;
  rects: Array<{ x: number; y: number; w: number; h: number; style: unknown }> = [];
  clearRect() {
    this.cleared++;
    this.rects = [];
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push({ x, y, w, h, style: this.fillStyle });
  }
}
const canvas = (ctx: Ctx2D | null, width = 480, height = 100): CanvasLike => ({ width, height, getContext: () => ctx });
const analyser = (fn: (i: number, n: number) => number, bins = 1024): AnalyserLike => ({
  frequencyBinCount: bins,
  getByteFrequencyData(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = fn(i, arr.length);
  },
});

describe("barEdges", () => {
  it("gives bars + 1 increasing edges within the bin range", () => {
    const e = barEdges(48, 1024, 44100);
    expect(e).toHaveLength(49);
    for (let i = 1; i < e.length; i++) expect(e[i]).toBeGreaterThan(e[i - 1]);
    expect(e[0]).toBeGreaterThanOrEqual(0);
  });
  it("spaces bars logarithmically: higher bars cover more bins", () => {
    const e = barEdges(16, 1024, 44100);
    expect(e[16] - e[15]).toBeGreaterThan(e[2] - e[1]);
  });
  it("clamps to the bins available and to Nyquist", () => {
    const e = barEdges(8, 64, 8000, 40, 16000);
    expect(Math.max(...e)).toBeLessThanOrEqual(64);
  });
  it("keeps edges strictly increasing even when bins run out", () => {
    const e = barEdges(32, 20, 44100);
    expect(e.length).toBe(33);
    expect(Math.max(...e)).toBeLessThanOrEqual(20);
  });
});

describe("computeBars", () => {
  const edges = barEdges(24, 1024, 44100);
  it("is all ones for a full-scale spectrum and all zeros for silence", () => {
    expect(computeBars(new Uint8Array(1024).fill(255), edges).every((v) => v === 1)).toBe(true);
    expect(computeBars(new Uint8Array(1024), edges).every((v) => v === 0)).toBe(true);
  });
  it("puts a 1 kHz tone in the right bar", () => {
    const bin = Math.round((1000 / 22050) * 1024);
    const data = new Uint8Array(1024);
    data[bin] = 200;
    const bars = computeBars(data, edges);
    const lit = bars.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    expect(lit).toHaveLength(1);
    expect(edges[lit[0]]).toBeLessThanOrEqual(bin);
    expect(edges[lit[0] + 1]).toBeGreaterThan(bin);
    expect(bars[lit[0]]).toBeCloseTo(200 / 255);
  });
  it("copes with data shorter than the edges", () => {
    expect(computeBars(new Uint8Array(4).fill(255), [0, 2, 9, 12])).toEqual([1, 1, 0]);
  });
});

describe("Visualizer", () => {
  it("draws one bar per slot, scaled to the canvas height, from the bottom up", () => {
    const g = new FakeCtx();
    const v = new Visualizer(canvas(g, 480, 100), () => analyser(() => 255), { bars: 48 });
    const levels = v.draw();
    expect(levels.every((l) => l === 1)).toBe(true);
    expect(g.rects).toHaveLength(48);
    for (const r of g.rects) {
      expect(r.h).toBe(100);
      expect(r.y).toBe(0);
    }
    expect(g.rects[1].x).toBeGreaterThan(g.rects[0].x);
    expect(g.rects.at(-1)!.x + g.rects.at(-1)!.w).toBeLessThanOrEqual(480);
    expect(g.cleared).toBe(1);
    expect(String(g.rects[0].style)).toMatch(/^hsl/);
  });
  it("lets bars fall gradually rather than snapping to zero", () => {
    const g = new FakeCtx();
    let loud = true;
    const v = new Visualizer(canvas(g), () => analyser(() => (loud ? 255 : 0)), { bars: 8, fall: 0.1 });
    v.draw();
    loud = false;
    const after1 = v.draw();
    expect(after1[0]).toBeCloseTo(0.9);
    for (let i = 0; i < 20; i++) v.draw();
    expect(v.draw()[0]).toBe(0);
  });
  it("draws flat bars when there is no analyser yet", () => {
    const g = new FakeCtx();
    const v = new Visualizer(canvas(g), () => null, { bars: 10 });
    expect(v.draw().every((l) => l === 0)).toBe(true);
    expect(g.rects).toHaveLength(10);
    expect(g.rects.every((r) => r.h === 1)).toBe(true);
  });
  it("does nothing visible without a 2D context", () => {
    const v = new Visualizer(canvas(null), () => analyser(() => 255), { bars: 4 });
    expect(v.draw()).toEqual([1, 1, 1, 1]);
  });
  it("rebuilds its bin map if the analyser size changes", () => {
    const g = new FakeCtx();
    let bins = 1024;
    const v = new Visualizer(canvas(g), () => analyser(() => 128, bins), { bars: 6, sampleRate: 48000 });
    v.draw();
    bins = 256;
    expect(v.draw().every((l) => l > 0)).toBe(true);
    expect(v.sampleRate).toBe(48000);
  });
});
