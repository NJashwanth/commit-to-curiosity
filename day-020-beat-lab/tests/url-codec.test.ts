import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/presets";
import { createDefaultState, validateState } from "../src/state";
import {
  CodecError,
  decodeState,
  encodeState,
  fletcher16,
  fromBase64Url,
  hashToState,
  stateToHash,
  toBase64Url,
} from "../src/url-codec";
import { fullState, randomState } from "./helpers";

/** Re-seal a payload with a fresh checksum, so only the field under test is wrong. */
const seal = (body: number[]) => {
  const sum = fletcher16(body);
  return toBase64Url([...body, sum >> 8, sum & 255]);
};
const bodyOf = (text: string) => [...fromBase64Url(text)].slice(0, -2);
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CodecError);
    return (e as Error).message;
  }
  throw new Error("expected a CodecError");
};

describe("base64url", () => {
  it("round-trips every length", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });
  it("uses only URL-safe characters and no padding", () => {
    expect(toBase64Url(Uint8Array.from([251, 255, 254, 255]))).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("matches known vectors", () => {
    expect(toBase64Url([77, 97, 110])).toBe("TWFu");
    expect(toBase64Url([77, 97])).toBe("TWE");
    expect(toBase64Url([77])).toBe("TQ");
  });
});

describe("round trip", () => {
  it("is exact for the default state", () => {
    const s = createDefaultState();
    expect(decodeState(encodeState(s))).toEqual(s);
  });
  it("is exact for every field across many random beats", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const s = randomState(seed, seed % 6 === 0 ? 0.95 : 0.4);
      expect(validateState(s)).toEqual([]);
      expect(decodeState(encodeState(s))).toEqual(s);
    }
  });
  it("is exact at every extreme", () => {
    const s = fullState();
    expect(decodeState(encodeState(s))).toEqual(s);
    const lo = createDefaultState();
    Object.assign(lo, { tempo: 60, swing: 0 });
    lo.patterns[2].length = 8;
    expect(decodeState(encodeState(lo))).toEqual(lo);
  });
  it("is exact for each preset", () => {
    for (const p of PRESETS) expect(decodeState(encodeState(p.state))).toEqual(p.state);
  });
  it("preserves each field on its own", () => {
    const check = (edit: (s: ReturnType<typeof createDefaultState>) => void) => {
      const s = createDefaultState();
      edit(s);
      expect(decodeState(encodeState(s))).toEqual(s);
    };
    check((s) => (s.tempo = 137));
    check((s) => (s.swing = 61));
    check((s) => (s.current = 3));
    check((s) => (s.chainMode = true));
    check((s) => (s.chain = [3, 0, 2, 2, 1]));
    check((s) => Object.assign(s.patterns[1].drums[5][9], { on: true, vel: 3, accent: true }));
    check((s) => Object.assign(s.patterns[3].synth[31], { on: true, vel: 16, accent: false, note: 100 }));
    check((s) => (s.patterns[0].length = 32));
    check((s) => (s.tracks[6].decay = 77));
    check((s) => (s.tracks[2].mute = true));
    check((s) => (s.tracks[7].solo = true));
    check((s) => (s.synth.wave = 3));
    check((s) => (s.synth.glide = 99));
    check((s) => (s.synth.solo = true));
    check((s) => (s.fx.delayDiv = 5));
    check((s) => (s.fx.reverbSize = 1));
  });
  it("is deterministic", () => {
    const s = randomState(9);
    expect(encodeState(s)).toBe(encodeState(structuredClone(s)));
  });
});

describe("size", () => {
  it("stays under 2000 characters even for the largest possible beat", () => {
    expect(encodeState(fullState()).length).toBeLessThan(2000);
    expect(stateToHash(fullState()).length).toBeLessThan(2000);
  });
  it("is much shorter for real beats", () => {
    for (const p of PRESETS) expect(encodeState(p.state).length).toBeLessThan(600);
    expect(encodeState(createDefaultState()).length).toBeLessThan(300);
  });
  it("stays under 2000 for dense random beats", () => {
    for (let seed = 100; seed < 120; seed++) expect(encodeState(randomState(seed, 1)).length).toBeLessThan(2000);
  });
});

describe("corrupt links are rejected with a clear error", () => {
  const good = encodeState(PRESETS[0].state);

  it("empty input", () => {
    expect(message(() => decodeState(""))).toMatch(/no beat data/);
  });
  it("characters that are not base64url", () => {
    expect(message(() => decodeState("abc$def"))).toMatch(/not valid here \("\$" at position 4\)/);
    expect(message(() => decodeState(good + "+"))).toMatch(/position/);
  });
  it("impossible lengths", () => {
    expect(message(() => decodeState("abcde"))).toMatch(/cut off/);
  });
  it("too short to hold a beat", () => {
    expect(message(() => decodeState("AAA"))).toMatch(/too short/);
  });
  it("a flipped character fails the checksum", () => {
    const i = Math.floor(good.length / 2);
    const bad = good.slice(0, i) + (good[i] === "A" ? "B" : "A") + good.slice(i + 1);
    expect(message(() => decodeState(bad))).toMatch(/checksum does not match/);
  });
  it("a truncated link fails", () => {
    expect(message(() => decodeState(good.slice(0, -8)))).toMatch(/checksum|too short/);
  });
  it("a different version", () => {
    const body = bodyOf(good);
    body[0] = 2;
    expect(message(() => decodeState(seal(body)))).toMatch(/different version of Beat Lab \(v2\)/);
  });
  it("valid checksum but data that ends early", () => {
    expect(message(() => decodeState(seal(bodyOf(good).slice(0, 20))))).toMatch(/ends early/);
  });
  it("valid checksum but extra data after the beat", () => {
    expect(message(() => decodeState(seal([...bodyOf(good), 0xff])))).toMatch(/extra data/);
  });
  it("out-of-range values that the checksum cannot catch", () => {
    const body = bodyOf(good);
    body[1] = 255; // tempo 60 + 255 = 315
    expect(message(() => decodeState(seal(body)))).toMatch(/invalid beat: tempo/);
  });
  it("a chain longer than allowed", () => {
    const body = bodyOf(good);
    // byte 3 is: current (low bit), chain mode, 4-bit chain length, then 2 bits of the next field.
    body[3] = (body[3] & 0b11000000) | (0b1111 << 2) | (body[3] & 0b11);
    expect(message(() => decodeState(seal(body)))).toMatch(/chain of 15/);
  });
  it("a pattern length code that does not exist", () => {
    const body = bodyOf(encodeState(createDefaultState()));
    // First pattern's length code starts right after the chain (empty), at bit 8+8+7+2+1+4 = 30.
    body[3] |= 0b11;
    expect(message(() => decodeState(seal(body)))).toMatch(/pattern length that does not exist/);
  });
  it("cannot encode an invalid state", () => {
    const s = createDefaultState();
    s.tempo = 5;
    expect(message(() => encodeState(s))).toMatch(/Cannot share an invalid beat: tempo/);
  });
});

describe("hashes", () => {
  it("builds and parses #b=...", () => {
    const s = PRESETS[1].state;
    const hash = stateToHash(s);
    expect(hash.startsWith("#b=")).toBe(true);
    expect(hashToState(hash)).toEqual(s);
    expect(hashToState(hash.slice(1))).toEqual(s);
  });
  it("returns null when there is no beat in the hash", () => {
    expect(hashToState("")).toBeNull();
    expect(hashToState("#")).toBeNull();
    expect(hashToState("#section-2")).toBeNull();
  });
  it("throws a CodecError for a damaged #b= hash", () => {
    expect(() => hashToState("#b=AAAA")).toThrow(CodecError);
    expect(() => hashToState("#b=")).toThrow(/no beat data/);
  });
});
