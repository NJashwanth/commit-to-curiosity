/** Turning activations into pixels: a perceptually even dark-to-bright scale (viridis-like), no rainbow. */

type RGB = [number, number, number];

// Control points sampled from viridis.
const STOPS: RGB[] = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
  [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
];

/** t in [0, 1] -> [r, g, b] in 0..255. Values outside the range are clamped. */
export function viridis(t: number): RGB {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((k) => Math.round(STOPS[i][k] + (STOPS[i + 1][k] - STOPS[i][k]) * f)) as RGB;
}

/** Largest value of a tensor's data (0 if empty or all non-positive), used to share one scale across a layer's maps. */
export function maxOf(data: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > m) m = data[i];
  return m;
}

/** RGBA bytes for `count` values starting at `offset` in `data`, scaled so `max` is the brightest. max <= 0 gives all-dark. */
export function toRGBA(data: ArrayLike<number>, offset: number, count: number, max: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    const [r, g, b] = viridis(max > 0 ? data[offset + i] / max : 0);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Grayscale RGBA for a 0..1 image (used for the 28x28 input the model sees: ink white on black). */
export function grayToRGBA(pixels: ArrayLike<number>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, pixels[i])) * 255);
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}
