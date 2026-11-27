import { describe, expect, it } from "vitest";
import { grayToRGBA, maxOf, toRGBA, viridis } from "../src/colormap";
import { formatPercent, headline, ranking, verdict } from "../src/format";

describe("colormap", () => {
  it("runs from dark purple to bright yellow and clamps", () => {
    expect(viridis(0)).toEqual([68, 1, 84]);
    expect(viridis(1)).toEqual([253, 231, 37]);
    expect(viridis(-5)).toEqual(viridis(0));
    expect(viridis(9)).toEqual(viridis(1));
    expect(viridis(NaN)).toEqual(viridis(0));
  });
  it("gets steadily brighter", () => {
    const lum = (t: number) => { const [r, g, b] = viridis(t); return 0.299 * r + 0.587 * g + 0.114 * b; };
    for (let t = 0.05; t <= 1; t += 0.05) expect(lum(t)).toBeGreaterThan(lum(t - 0.05));
  });
  it("maxOf ignores negatives and handles empty input", () => {
    expect(maxOf([-3, 0.5, 2, 1])).toBe(2);
    expect(maxOf([-1, -2])).toBe(0);
    expect(maxOf([])).toBe(0);
  });
  it("toRGBA scales a slice of a layer by a shared maximum", () => {
    const data = [0, 1, 2, 4, 0, 4];
    const px = toRGBA(data, 3, 3, 4); // values 4, 0, 4 of max 4
    expect(Array.from(px.slice(0, 4))).toEqual([...viridis(1), 255]);
    expect(Array.from(px.slice(4, 8))).toEqual([...viridis(0), 255]);
    expect(Array.from(toRGBA(data, 0, 2, 0).slice(0, 4))).toEqual([...viridis(0), 255]); // max 0: all dark
  });
  it("grayToRGBA maps 0..1 to white ink on black", () => {
    expect(Array.from(grayToRGBA([0, 0.5, 1, 2, -1]))).toEqual([
      0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
    ]);
  });
});

describe("readout formatting", () => {
  it("formats percentages", () => {
    expect(formatPercent(0.9831)).toBe("98.3%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.9999)).toBe("100%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(NaN)).toBe("0%");
    expect(formatPercent(0.0004)).toBe("<0.1%");
    expect(formatPercent(0.0123)).toBe("1.2%");
  });
  it("ranks digits by probability with ties in digit order", () => {
    expect(ranking([0.1, 0.5, 0.2, 0.2])).toEqual([1, 2, 3, 0]);
    expect(ranking([])).toEqual([]);
  });
  it("describes how sure the model is", () => {
    expect(verdict(0.99, true)).toBe("empty");
    expect(verdict(0.3, false)).toBe("unsure");
    expect(verdict(0.7, false)).toBe("likely");
    expect(verdict(0.95, false)).toBe("confident");
    expect(headline(0, 0, true)).toBe("Draw a digit");
    expect(headline(4, 0.3, false)).toBe("Not sure (best guess 4)");
    expect(headline(4, 0.7, false)).toBe("Probably 4");
    expect(headline(4, 0.97, false)).toBe("4");
  });
});
