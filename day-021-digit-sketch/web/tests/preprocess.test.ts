import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOX, CENTER, SIZE, areaWeights, centerOfMass, preprocess, resizeArea, rgbaToInk, roundHalfUp,
} from "../src/preprocess";

const fx = JSON.parse(readFileSync(new URL("./fixtures/preprocess.json", import.meta.url), "utf8"));

function blob(w: number, h: number, x0: number, x1: number, y0: number, y1: number, v = 1): Float32Array {
  const img = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img[y * w + x] = v;
  return img;
}
const com = (p: Float32Array) => centerOfMass(p, SIZE, SIZE)!;
const inkBox = (p: Float32Array) => {
  let x0 = SIZE, x1 = -1, y0 = SIZE, y1 = -1;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (p[y * SIZE + x] > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, x1, y0, y1 };
};

describe("matches the Python preprocessing on shared fixtures", () => {
  it.each((fx.cases as any[]).map((c): [string, any] => [c.name, c]))("%s", (_name: string, c: any) => {
    const gray = Float32Array.from((c.pixels as number[]).map((v) => v / 255));
    const out = preprocess(gray, c.width, c.height);
    expect(out.empty).toBe(c.empty);
    expect(out.pixels).toHaveLength(784);
    let worst = 0;
    for (let i = 0; i < 784; i++) worst = Math.max(worst, Math.abs(out.pixels[i] - c.expected[i]));
    expect(worst).toBeLessThan(1e-5);
  });
});

describe("centering by center of mass", () => {
  it("moves an L shape so its mass, not its bounding box, is centered", () => {
    const w = 80;
    const img = blob(w, w, 10, 20, 10, 70);
    img.set(blob(w, w, 10, 60, 60, 70));
    for (let i = 0; i < img.length; i++) img[i] = Math.max(img[i], blob(w, w, 10, 20, 10, 70)[i]);
    const out = preprocess(img, w, w);
    const [cy, cx] = com(out.pixels);
    expect(Math.abs(cy - CENTER)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(cx - CENTER)).toBeLessThanOrEqual(0.5);
    const b = inkBox(out.pixels);
    expect(Math.abs((b.x0 + b.x1 + 1) / 2 - CENTER)).toBeGreaterThan(1); // the box itself is off-center
  });

  it("a symmetric blob with an even size ends up exactly in the middle of the field", () => {
    const out = preprocess(blob(100, 100, 30, 50, 30, 70), 100, 100); // 20 x 40 -> 10 x 20 pixels
    expect(com(out.pixels)[0]).toBeCloseTo(14, 6);
    expect(com(out.pixels)[1]).toBeCloseTo(14, 6);
  });

  it("scales the longer side to 20 pixels and keeps the aspect ratio", () => {
    const b = inkBox(preprocess(blob(100, 100, 40, 50, 10, 90), 100, 100).pixels); // 10 wide, 80 tall
    expect(b.y1 - b.y0 + 1).toBe(BOX);
    expect(b.x1 - b.x0 + 1).toBe(3); // 10 * 20/80 = 2.5 -> 3
  });

  it("does not depend on where the drawing is or how large it was drawn", () => {
    const a = preprocess(blob(60, 60, 10, 25, 10, 40), 60, 60).pixels;
    const b = preprocess(blob(300, 200, 100, 175, 20, 170), 300, 200).pixels;
    for (let i = 0; i < 784; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-6);
  });

  it("normalizes the peak to 1 so thin strokes are not faint", () => {
    const out = preprocess(blob(100, 100, 48, 50, 5, 95, 0.4), 100, 100).pixels;
    expect(Math.max(...out)).toBeCloseTo(1, 6);
  });

  it("keeps the digit inside the 28x28 field even when its mass is far off to one side", () => {
    const w = 100;
    const img = blob(w, w, 0, 4, 0, 100);
    for (let x = 0; x < w; x++) img[50 * w + x] = Math.max(img[50 * w + x], 0.3);
    const out = preprocess(img, w, w);
    const b = inkBox(out.pixels);
    expect(b.x0).toBeGreaterThanOrEqual(0);
    expect(b.x1).toBeLessThanOrEqual(27);
    expect(out.pixels.reduce((a, c) => a + c, 0)).toBeGreaterThan(0);
  });
});

describe("empty and degenerate drawings", () => {
  it("an empty canvas gives an all-zero 28x28 and says so", () => {
    const out = preprocess(new Float32Array(280 * 280), 280, 280);
    expect(out.empty).toBe(true);
    expect(out.box).toBeNull();
    expect(out.pixels).toHaveLength(784);
    expect(Math.max(...out.pixels)).toBe(0);
  });

  it("values at or below the ink threshold do not count as drawing", () => {
    expect(preprocess(new Float32Array(100).fill(0.5), 10, 10, 0.5).empty).toBe(true); // 0.5 is exact in float32
    expect(preprocess(new Float32Array(100).fill(0.51), 10, 10, 0.5).empty).toBe(false);
    expect(preprocess(new Float32Array(100).fill(0.09), 10, 10).empty).toBe(true);     // default threshold is 0.1
  });

  it("a single pixel of ink still produces a centered dot", () => {
    const img = new Float32Array(50 * 50);
    img[20 * 50 + 30] = 1;
    const out = preprocess(img, 50, 50);
    expect(out.empty).toBe(false);
    expect(out.box).toEqual({ x0: 30, y0: 20, x1: 30, y1: 20 });
    expect(Math.abs(com(out.pixels)[0] - CENTER)).toBeLessThanOrEqual(0.5);
  });

  it("rejects a buffer that does not match the stated size", () => {
    expect(() => preprocess(new Float32Array(10), 4, 4)).toThrow(/expected 16 pixels/);
  });
});

describe("building blocks", () => {
  it("area weights are row-normalized and resizing preserves the mean", () => {
    for (const [src, dst] of [[100, 20], [7, 20], [20, 20], [33, 5]]) {
      const w = areaWeights(src, dst);
      for (let i = 0; i < dst; i++) {
        let s = 0;
        for (let j = 0; j < src; j++) s += w[i * src + j];
        expect(s).toBeCloseTo(1, 9);
      }
    }
    const img = Float64Array.from({ length: 12 * 8 }, (_, i) => (i * 37) % 11);
    const mean = (a: ArrayLike<number>) => Array.from(a).reduce((x, y) => x + y, 0) / a.length;
    expect(mean(resizeArea(img, 12, 8, 6, 4))).toBeCloseTo(mean(img), 9);
    expect(Array.from(resizeArea(img, 12, 8, 12, 8))).toEqual(Array.from(img));
  });

  it("center of mass uses continuous coordinates", () => {
    const img = new Float32Array(28 * 28);
    for (const [y, x] of [[13, 13], [13, 14], [14, 13], [14, 14]]) img[y * 28 + x] = 1;
    expect(centerOfMass(img, 28, 28)).toEqual([14, 14]);
    expect(centerOfMass(new Float32Array(9), 3, 3)).toBeNull();
  });

  it("rounds halves up, and an exact tie hit by floating point noise still goes up", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4].map(roundHalfUp)).toEqual([1, 2, 3, 0, -1, 2]);
    expect(roundHalfUp(10.5 - 1e-13)).toBe(11);
    expect(roundHalfUp(10.4999)).toBe(10);
  });

  it("rgbaToInk uses luminance and ignores alpha", () => {
    const px = Uint8ClampedArray.of(255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0);
    const ink = rgbaToInk(px);
    expect(ink[0]).toBeCloseTo(1, 6);
    expect(ink[1]).toBe(0);
    expect(ink[2]).toBeCloseTo(0.299, 6);
    expect(ink[3]).toBeCloseTo(0.587, 6);
  });
});
