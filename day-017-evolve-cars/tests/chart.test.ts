import { describe, expect, it } from "vitest";
import { niceMax, renderChart } from "../src/chart";

const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ generation: i + 1, best: 10 + i * 5, average: 5 + i * 2 }));

describe("niceMax", () => {
  it("rounds up to 1, 2 or 5 times a power of ten", () => {
    expect(niceMax(0)).toBe(10);
    expect(niceMax(-3)).toBe(10);
    expect(niceMax(0.8)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(21)).toBe(50);
    expect(niceMax(51)).toBe(100);
    expect(niceMax(100)).toBe(100);
  });
});

describe("renderChart", () => {
  it("is a well formed svg with best and average lines", () => {
    const svg = renderChart(pts(10));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('class="best"');
    expect(svg).toContain('class="avg"');
    const best = /class="best" fill="none" points="([^"]+)"/.exec(svg)![1].split(" ");
    expect(best).toHaveLength(10);
  });

  it("best line climbs on screen as fitness rises (y shrinks)", () => {
    const svg = renderChart(pts(6));
    const ys = /class="best" fill="none" points="([^"]+)"/.exec(svg)![1].split(" ").map((p) => Number(p.split(",")[1]));
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1]);
  });

  it("handles no data and a single generation", () => {
    expect(renderChart([])).not.toContain("<polyline");
    const one = renderChart(pts(1), { width: 200, height: 100 });
    expect(one).toContain("<circle");
    expect(one).toContain('viewBox="0 0 200 100"');
    expect(one).not.toContain("<polyline");
  });

  it("keeps every coordinate inside the viewBox", () => {
    const svg = renderChart(pts(30));
    for (const m of svg.matchAll(/points="([^"]+)"/g)) {
      for (const pair of m[1].split(" ")) {
        const [x, y] = pair.split(",").map(Number);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(320);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(170);
      }
    }
  });
});
