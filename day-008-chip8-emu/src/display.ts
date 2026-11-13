export const WIDTH = 64;
export const HEIGHT = 32;

export type RGB = readonly [number, number, number];

/** The 64x32 monochrome framebuffer. One byte per pixel, 1 = on. */
export class Display {
  readonly pixels = new Uint8Array(WIDTH * HEIGHT);
  /** Set whenever pixels change. The renderer clears it after painting. */
  dirty = true;

  clear(): void {
    this.pixels.fill(0);
    this.dirty = true;
  }

  get(x: number, y: number): boolean {
    return this.pixels[y * WIDTH + x] === 1;
  }

  /**
   * XOR an 8-pixel-wide sprite onto the screen, one byte per row, most
   * significant bit on the left. The starting position always wraps; pixels
   * that run past an edge are clipped or wrapped depending on `clip`.
   * Returns true if any pixel was turned off (a collision).
   */
  drawSprite(x: number, y: number, rows: ArrayLike<number>, clip: boolean): boolean {
    const x0 = x % WIDTH;
    const y0 = y % HEIGHT;
    let collision = false;
    for (let r = 0; r < rows.length; r++) {
      let py = y0 + r;
      if (py >= HEIGHT) {
        if (clip) break;
        py %= HEIGHT;
      }
      const bits = rows[r];
      for (let c = 0; c < 8; c++) {
        if ((bits & (0x80 >> c)) === 0) continue;
        let px = x0 + c;
        if (px >= WIDTH) {
          if (clip) break;
          px %= WIDTH;
        }
        const idx = py * WIDTH + px;
        if (this.pixels[idx]) collision = true;
        this.pixels[idx] ^= 1;
      }
    }
    this.dirty = true;
    return collision;
  }

  /** Text rendering for tests and debugging: one line per row. */
  toString(on = "#", off = "."): string {
    const lines: string[] = [];
    for (let y = 0; y < HEIGHT; y++) {
      let line = "";
      for (let x = 0; x < WIDTH; x++) line += this.get(x, y) ? on : off;
      lines.push(line);
    }
    return lines.join("\n");
  }
}

/** Parse "#rgb" or "#rrggbb" into an RGB triple. */
export function parseColor(color: string): RGB {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) throw new Error(`Not a hex color: ${color}`);
  let digits = m[1];
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join("");
  const n = parseInt(digits, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Convert the framebuffer to RGBA bytes for ImageData, reusing `out` when given. */
export function toRGBA(
  display: Display,
  on: RGB,
  off: RGB,
  out = new Uint8ClampedArray(WIDTH * HEIGHT * 4),
): Uint8ClampedArray {
  const { pixels } = display;
  for (let k = 0; k < pixels.length; k++) {
    const [r, g, b] = pixels[k] ? on : off;
    const o = k * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 255;
  }
  return out;
}
