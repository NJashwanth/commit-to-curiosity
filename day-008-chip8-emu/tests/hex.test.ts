import { describe, expect, it } from "vitest";
import { hex } from "../src/hex";

describe("hex", () => {
  it("pads to two digits by default", () => {
    expect(hex(0xa)).toBe("0A");
    expect(hex(0xff)).toBe("FF");
  });

  it("pads to a custom width", () => {
    expect(hex(0x200, 3)).toBe("200");
    expect(hex(0xe0, 4)).toBe("00E0");
  });

  it("does not truncate wider values", () => {
    expect(hex(0x1234, 2)).toBe("1234");
  });
});
