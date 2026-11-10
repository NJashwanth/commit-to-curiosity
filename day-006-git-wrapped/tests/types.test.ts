import { describe, expect, it } from "vitest";
import { SLIDE_IDS } from "../src/types";

describe("slide layout", () => {
  it("has between 8 and 10 unique slides, starting with intro and ending with summary", () => {
    expect(SLIDE_IDS.length).toBeGreaterThanOrEqual(8);
    expect(SLIDE_IDS.length).toBeLessThanOrEqual(10);
    expect(new Set(SLIDE_IDS).size).toBe(SLIDE_IDS.length);
    expect(SLIDE_IDS[0]).toBe("intro");
    expect(SLIDE_IDS.at(-1)).toBe("summary");
  });
});
