// Stroke paths for the digits 0 to 9, in a unit box (x right, y down), for driving the drawing canvas
// from a script. Each digit is a list of strokes; each stroke is a list of [x, y] points.

const rad = (deg) => (deg * Math.PI) / 180;

/** Points along an ellipse arc, angles in degrees measured clockwise from the right (0 = right, 90 = bottom, -90 = top). */
function arc(cx, cy, rx, ry, from, to, n = 28) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = rad(from + ((to - from) * i) / n);
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}

function line(...pts) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const n = 10;
    for (let k = i === 0 ? 0 : 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

export const DIGITS = {
  0: [arc(0.5, 0.5, 0.33, 0.46, -90, 270, 40)],
  1: [line([0.32, 0.22], [0.5, 0.04], [0.5, 0.96])],
  2: [[...arc(0.5, 0.29, 0.33, 0.25, -190, 20, 22), ...line([0.78, 0.4], [0.14, 0.95], [0.9, 0.95]).slice(1)]],
  3: [[...arc(0.48, 0.26, 0.32, 0.22, -150, 90, 24), ...arc(0.48, 0.7, 0.36, 0.26, -90, 150, 24)]],
  4: [line([0.68, 0.04], [0.1, 0.66], [0.92, 0.66]), line([0.68, 0.04], [0.68, 0.96])],
  5: [[...line([0.8, 0.06], [0.28, 0.06], [0.22, 0.46]), ...arc(0.5, 0.68, 0.36, 0.28, -125, 140, 28)]],
  6: [[...line([0.68, 0.04], [0.3, 0.38], [0.17, 0.7]), ...arc(0.5, 0.71, 0.33, 0.25, 180, 540, 36)]],
  7: [line([0.1, 0.08], [0.9, 0.08], [0.4, 0.96])],
  8: [arc(0.5, 0.27, 0.26, 0.22, -90, 270, 28), arc(0.5, 0.72, 0.34, 0.25, -90, 270, 32)],
  9: [arc(0.5, 0.3, 0.3, 0.26, -90, 270, 32), line([0.8, 0.3], [0.74, 0.62], [0.42, 0.96])],
};

/** Strokes mapped into a pixel box: [{x, y}] lists. */
export function strokesInBox(digit, box) {
  return DIGITS[digit].map((stroke) => stroke.map(([x, y]) => ({ x: box.x + x * box.w, y: box.y + y * box.h })));
}
