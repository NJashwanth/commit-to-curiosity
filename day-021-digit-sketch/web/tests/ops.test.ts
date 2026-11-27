import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { argmax, conv2d, dense, flatten, maxpool2d, relu, softmax } from "../src/nn/ops";
import { Tensor, sameShape, sizeOf, tensor } from "../src/nn/tensor";

interface T {
  shape: number[];
  data: number[];
}
const fx = JSON.parse(readFileSync(new URL("./fixtures/ops.json", import.meta.url), "utf8"));
const asTensor = (t: T): Tensor => tensor(t.shape, t.data);
const f32 = (t: T) => Float32Array.from(t.data);

const cases = (list: any[]): [number, any][] => list.map((c, i) => [i, c]);

function expectClose(actual: Tensor, expected: T, tol = 1e-5) {
  expect(actual.shape).toEqual(expected.shape);
  expect(actual.data.length).toBe(expected.data.length);
  let worst = 0;
  for (let i = 0; i < expected.data.length; i++) worst = Math.max(worst, Math.abs(actual.data[i] - Math.fround(expected.data[i])));
  expect(worst).toBeLessThanOrEqual(tol);
}

describe("operations match the outputs PyTorch computed (fixtures from train/fixtures.py)", () => {
  it.each(cases(fx.conv2d))("conv2d case %i", (_i: number, c: any) => {
    expectClose(conv2d(asTensor(c.input), f32(c.weight), f32(c.bias), c.out, c.kernel), c.expected);
  });
  it.each(cases(fx.relu))("relu case %i", (_i: number, c: any) => {
    expectClose(relu(asTensor(c.input)), c.expected, 0);
  });
  it.each(cases(fx.maxpool))("maxpool case %i", (_i: number, c: any) => {
    expectClose(maxpool2d(asTensor(c.input), c.size), c.expected, 0);
  });
  it.each(cases(fx.flatten))("flatten case %i", (_i: number, c: any) => {
    expectClose(flatten(asTensor(c.input)), c.expected, 0);
  });
  it.each(cases(fx.dense))("dense case %i", (_i: number, c: any) => {
    expectClose(dense(asTensor(c.input), f32(c.weight), f32(c.bias), c.out), c.expected);
  });
  it.each(cases(fx.softmax))("softmax case %i", (_i: number, c: any) => {
    expectClose(softmax(asTensor(c.input)), c.expected, 1e-6);
  });
});

describe("softmax", () => {
  it("sums to 1 and stays finite for huge logits", () => {
    for (const scale of [0.01, 1, 50, 1000]) {
      const x = tensor([10], Array.from({ length: 10 }, (_, i) => (i - 4) * scale));
      const p = softmax(x);
      expect(p.data.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
      expect(Array.from(p.data).every(Number.isFinite)).toBe(true);
      expect(argmax(p.data)).toBe(9);
    }
  });
  it("gives equal logits equal probability", () => {
    const p = softmax(tensor([4], [3, 3, 3, 3]));
    expect(Array.from(p.data)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});

describe("hand-checked cases", () => {
  it("conv2d sums a 3x3 window and adds the bias", () => {
    const x = tensor([1, 4, 4], Array.from({ length: 16 }, (_, i) => i));
    const out = conv2d(x, new Float32Array(9).fill(1), Float32Array.of(1), 1, 3);
    expect(out.shape).toEqual([1, 2, 2]);
    expect(out.data[0]).toBe(0 + 1 + 2 + 4 + 5 + 6 + 8 + 9 + 10 + 1);
    expect(out.data[3]).toBe(5 + 6 + 7 + 9 + 10 + 11 + 13 + 14 + 15 + 1);
  });
  it("maxpool drops the odd edge", () => {
    const out = maxpool2d(tensor([1, 3, 3], [1, 2, 9, 3, 4, 9, 9, 9, 9]), 2);
    expect(out.shape).toEqual([1, 1, 1]);
    expect(out.data[0]).toBe(4);
  });
  it("flatten keeps channel-major order", () => {
    expect(Array.from(flatten(tensor([2, 1, 2], [1, 2, 3, 4])).data)).toEqual([1, 2, 3, 4]);
  });
  it("argmax picks the first of equal maxima and handles one element", () => {
    expect(argmax([1, 5, 5, 2])).toBe(1);
    expect(argmax([7])).toBe(0);
  });
});

describe("shape checking", () => {
  it("rejects inputs the op cannot take", () => {
    const flat = tensor([4]);
    const img = tensor([1, 4, 4]);
    expect(() => conv2d(flat, new Float32Array(9), new Float32Array(1), 1, 3)).toThrow(/\[C, H, W\]/);
    expect(() => conv2d(tensor([1, 2, 2]), new Float32Array(9), new Float32Array(1), 1, 3)).toThrow(/smaller/);
    expect(() => conv2d(img, new Float32Array(8), new Float32Array(1), 1, 3)).toThrow(/weight has 8/);
    expect(() => conv2d(img, new Float32Array(9), new Float32Array(2), 1, 3)).toThrow(/bias has 2/);
    expect(() => maxpool2d(flat, 2)).toThrow(/\[C, H, W\]/);
    expect(() => maxpool2d(tensor([1, 1, 1]), 2)).toThrow(/smaller/);
    expect(() => dense(img, new Float32Array(4), new Float32Array(1), 1)).toThrow(/flat input/);
    expect(() => dense(flat, new Float32Array(3), new Float32Array(1), 1)).toThrow(/weight has 3/);
    expect(() => dense(flat, new Float32Array(4), new Float32Array(2), 1)).toThrow(/bias has 2/);
  });
  it("tensor helpers", () => {
    expect(sizeOf([2, 3, 4])).toBe(24);
    expect(tensor([2, 2]).data).toEqual(new Float32Array(4));
    expect(() => tensor([2, 2], [1, 2, 3])).toThrow(/needs 4 values/);
    expect(sameShape([1, 2], [1, 2])).toBe(true);
    expect(sameShape([1, 2], [1, 3])).toBe(false);
    expect(sameShape([1], [1, 1])).toBe(false);
  });
});
