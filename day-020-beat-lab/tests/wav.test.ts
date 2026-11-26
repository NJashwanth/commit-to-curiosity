import { describe, expect, it } from "vitest";
import { WAV_HEADER_BYTES, encodeWav, floatToInt16 } from "../src/wav";

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

describe("floatToInt16", () => {
  it("maps the range onto 16 bits", () => {
    expect(floatToInt16(0)).toBe(0);
    expect(floatToInt16(1)).toBe(32767);
    expect(floatToInt16(-1)).toBe(-32768);
    expect(floatToInt16(0.5)).toBe(16384);
    expect(floatToInt16(-0.5)).toBe(-16384);
  });
  it("clamps anything beyond full scale", () => {
    expect(floatToInt16(1.5)).toBe(32767);
    expect(floatToInt16(100)).toBe(32767);
    expect(floatToInt16(-2)).toBe(-32768);
    expect(floatToInt16(-1e9)).toBe(-32768);
    expect(floatToInt16(Infinity)).toBe(32767);
    expect(floatToInt16(-Infinity)).toBe(-32768);
  });
  it("turns NaN into silence", () => {
    expect(floatToInt16(NaN)).toBe(0);
  });
});

describe("encodeWav header", () => {
  const frames = 100;
  const wav = encodeWav([new Float32Array(frames), new Float32Array(frames)], 44100);
  const v = view(wav);
  it("is a RIFF/WAVE file with a fmt and data chunk", () => {
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");
  });
  it("has the right sizes", () => {
    const dataBytes = frames * 2 * 2;
    expect(wav.length).toBe(WAV_HEADER_BYTES + dataBytes);
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(dataBytes);
  });
  it("describes 16-bit stereo PCM at the sample rate", () => {
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(44100 * 4);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(16);
  });
  it("handles mono and other sample rates", () => {
    const m = encodeWav([new Float32Array(10)], 22050);
    const mv = view(m);
    expect(mv.getUint16(22, true)).toBe(1);
    expect(mv.getUint32(28, true)).toBe(22050 * 2);
    expect(mv.getUint16(32, true)).toBe(2);
    expect(m.length).toBe(44 + 20);
  });
  it("encodes an empty buffer as a header only", () => {
    const e = encodeWav([[]], 8000);
    expect(e.length).toBe(44);
    expect(view(e).getUint32(40, true)).toBe(0);
  });
});

describe("encodeWav samples", () => {
  it("interleaves channels as little-endian int16", () => {
    const wav = encodeWav([[0.5, -0.5], [1, -1]], 8000);
    const v = view(wav);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([16384, 32767, -16384, -32768]);
  });
  it("clamps out-of-range samples and never wraps", () => {
    const wav = encodeWav([[3, -3, 1.0001, NaN]], 8000);
    const v = view(wav);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([32767, -32768, 32767, 0]);
  });
  it("round-trips a sine wave to within one 16-bit step", () => {
    const n = 500;
    const sine = Float32Array.from({ length: n }, (_, i) => 0.8 * Math.sin((2 * Math.PI * 5 * i) / n));
    const v = view(encodeWav([sine], 8000));
    for (let i = 0; i < n; i++) expect(Math.abs(v.getInt16(44 + i * 2, true) / 32768 - sine[i])).toBeLessThan(1 / 16384);
  });
});

describe("encodeWav errors", () => {
  it("rejects no channels, ragged channels and bad sample rates", () => {
    expect(() => encodeWav([], 44100)).toThrow(/at least one channel/);
    expect(() => encodeWav([[0, 0], [0]], 44100)).toThrow(/same length/);
    expect(() => encodeWav([[0]], 0)).toThrow(/Sample rate/);
    expect(() => encodeWav([[0]], 44100.5)).toThrow(/Sample rate/);
  });
});
