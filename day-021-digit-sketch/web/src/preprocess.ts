/**
 * MNIST-style preprocessing: crop to the ink, scale to 20x20, center by center of mass in 28x28.
 *
 * This is the same recipe as train/preprocess.py, written with the same conventions so a test can
 * compare the two on shared fixtures:
 *   - ink is high, values in [0, 1]; a pixel is ink for the bounding box when it is above INK_THRESHOLD
 *   - resizing is exact area averaging
 *   - the scaled digit is divided by its maximum so thin strokes do not come out faint
 *   - the center of mass is measured in continuous coordinates (pixel i covers [i, i+1])
 *   - the offset is floor(x + 0.5 + 1e-9) (so exact ties cannot flip on summation order), and the digit
 *     is kept entirely inside the 28x28 field
 */
export const SIZE = 28;
export const BOX = 20;
export const CENTER = SIZE / 2;
export const INK_THRESHOLD = 0.1;

export const TIE_EPSILON = 1e-9;

/** floor(x + 0.5), nudged so an exact tie that floating point noise puts a hair below .5 still rounds up. */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5 + TIE_EPSILON);
}

/** Row-major (dst x src) matrix of exact area-average weights. */
export function areaWeights(src: number, dst: number): Float64Array {
  const w = new Float64Array(dst * src);
  const ratio = src / dst;
  for (let i = 0; i < dst; i++) {
    const lo = i * ratio;
    const hi = (i + 1) * ratio;
    for (let j = Math.floor(lo); j < Math.min(src, Math.ceil(hi)); j++) {
      const overlap = Math.min(hi, j + 1) - Math.max(lo, j);
      if (overlap > 0) w[i * src + j] = overlap / ratio;
    }
  }
  return w;
}

/** Area-average resize of a row-major (h x w) image to (nh x nw). */
export function resizeArea(img: ArrayLike<number>, h: number, w: number, nh: number, nw: number): Float64Array {
  const wy = areaWeights(h, nh);
  const wx = areaWeights(w, nw);
  const tmp = new Float64Array(h * nw); // columns resized first
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let j = 0; j < w; j++) s += img[y * w + j] * wx[x * w + j];
      tmp[y * nw + x] = s;
    }
  }
  const out = new Float64Array(nh * nw);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let i = 0; i < h; i++) s += wy[y * h + i] * tmp[i * nw + x];
      out[y * nw + x] = s;
    }
  }
  return out;
}

/** [y, x] center of mass in continuous coordinates, or null when there is no ink. */
export function centerOfMass(img: ArrayLike<number>, h: number, w: number): [number, number] | null {
  let mass = 0;
  let my = 0;
  let mx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = img[y * w + x];
      mass += v;
      my += v * (y + 0.5);
      mx += v * (x + 0.5);
    }
  }
  return mass > 0 ? [my / mass, mx / mass] : null;
}

/** Convert canvas RGBA bytes to ink values in [0, 1] using luminance, for a light-on-dark drawing. */
export function rgbaToInk(rgba: ArrayLike<number>): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
  }
  return out;
}

export interface Preprocessed {
  /** 784 values in [0, 1]: what the model gets (before mean/std normalization). All zero when empty. */
  pixels: Float32Array;
  empty: boolean;
  /** Bounding box of the ink in the source drawing, or null when empty. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** Turn a drawing (ink high, values in [0, 1], row-major width x height) into a 28x28 MNIST-style image. */
export function preprocess(gray: ArrayLike<number>, width: number, height: number, threshold = INK_THRESHOLD): Preprocessed {
  if (gray.length !== width * height) throw new Error(`expected ${width * height} pixels for ${width}x${height}, got ${gray.length}`);
  const pixels = new Float32Array(SIZE * SIZE);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { pixels, empty: true, box: null };

  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const crop = new Float64Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = gray[(y0 + y) * width + x0 + x];

  const scale = BOX / Math.max(cw, ch);
  const nw = Math.max(1, roundHalfUp(cw * scale));
  const nh = Math.max(1, roundHalfUp(ch * scale));
  const small = resizeArea(crop, ch, cw, nh, nw);
  let peak = 0;
  for (const v of small) if (v > peak) peak = v;
  if (peak > 0) for (let i = 0; i < small.length; i++) small[i] /= peak;

  const [cy, cx] = centerOfMass(small, nh, nw)!; // the crop has ink, so the scaled image does too
  const top = Math.min(Math.max(roundHalfUp(CENTER - cy), 0), SIZE - nh);
  const left = Math.min(Math.max(roundHalfUp(CENTER - cx), 0), SIZE - nw);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) pixels[(top + y) * SIZE + left + x] = small[y * nw + x];
  return { pixels, empty: false, box: { x0, y0, x1, y1 } };
}
