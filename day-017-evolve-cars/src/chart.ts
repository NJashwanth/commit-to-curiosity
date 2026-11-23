// Fitness chart as an inline SVG string. No chart library, no DOM needed, so it
// can be unit tested in Node.

export interface ChartPoint {
  generation: number;
  best: number;
  average: number;
}

export interface ChartOptions {
  width?: number;
  height?: number;
}

const PAD = { left: 42, right: 10, top: 10, bottom: 34 };

/** Round `max` up to a tidy axis maximum (1, 2, 5 times a power of ten). */
export function niceMax(max: number): number {
  if (!(max > 0)) return 10;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (max <= m * pow) return m * pow;
  return 10 * pow;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function line(points: ChartPoint[], key: "best" | "average", x: (g: number) => number, y: (v: number) => number): string {
  return points.map((p) => `${x(p.generation).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
}

export function renderChart(points: readonly ChartPoint[], opts: ChartOptions = {}): string {
  const width = opts.width ?? 320;
  const height = opts.height ?? 170;
  const w = width - PAD.left - PAD.right;
  const h = height - PAD.top - PAD.bottom;
  const yMax = niceMax(Math.max(0, ...points.map((p) => p.best)));
  const first = points.length ? points[0].generation : 1;
  const last = points.length ? points[points.length - 1].generation : 1;
  const span = Math.max(1, last - first);
  const x = (g: number) => PAD.left + (points.length > 1 ? ((g - first) / span) * w : w / 2);
  const y = (v: number) => PAD.top + h - (v / yMax) * h;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Fitness by generation">`);
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    parts.push(`<line class="grid" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`);
    parts.push(`<text class="tick" x="${PAD.left - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`);
  }
  const xTicks = points.length > 1 ? [first, Math.round((first + last) / 2), last] : [first];
  for (const g of new Set(xTicks)) {
    parts.push(`<text class="tick" x="${x(g).toFixed(1)}" y="${height - 16}" text-anchor="middle">${g}</text>`);
  }
  if (points.length > 1) {
    parts.push(`<polyline class="avg" fill="none" points="${line([...points], "average", x, y)}"/>`);
    parts.push(`<polyline class="best" fill="none" points="${line([...points], "best", x, y)}"/>`);
  }
  for (const p of points.length === 1 ? points : points.slice(-1)) {
    parts.push(`<circle class="best-dot" cx="${x(p.generation).toFixed(1)}" cy="${y(p.best).toFixed(1)}" r="3"/>`);
    parts.push(`<circle class="avg-dot" cx="${x(p.generation).toFixed(1)}" cy="${y(p.average).toFixed(1)}" r="2.5"/>`);
  }
  parts.push(`<text class="axis" x="${width / 2}" y="${height - 3}" text-anchor="middle">generation</text>`);
  parts.push("</svg>");
  return parts.join("");
}
