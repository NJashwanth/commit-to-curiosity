import { describe, expect, it } from "vitest";
import { Value } from "../src/engine";
import { MLP, mse } from "../src/nn";
import { Adam, SGD, makeOptimizer } from "../src/optim";

function params(): [Value, Value] {
  return [new Value(1), new Value(-2)];
}

describe("SGD", () => {
  it("one step is p -= lr·g", () => {
    const [a, b] = params();
    a.grad = 0.5;
    b.grad = -1;
    new SGD([a, b], { lr: 0.1 }).step();
    expect(a.data).toBeCloseTo(0.95, 15);
    expect(b.data).toBeCloseTo(-1.9, 15);
  });

  it("momentum carries the last velocity", () => {
    const [a] = params();
    const opt = new SGD([a], { lr: 0.1, momentum: 0.9 });
    a.grad = 0.5;
    opt.step(); // v = 0.5,                p = 1 - 0.05 = 0.95
    opt.step(); // v = 0.9·0.5 + 0.5 = 0.95, p = 0.95 - 0.095 = 0.855
    expect(a.data).toBeCloseTo(0.855, 15);
  });

  it("zeroGrad clears its parameters", () => {
    const ps = params();
    ps[0].grad = 3;
    ps[1].grad = -3;
    new SGD(ps).zeroGrad();
    expect(ps.map((p) => p.grad)).toEqual([0, 0]);
  });

  it("validates its settings", () => {
    expect(() => new SGD(params(), { lr: 0 })).toThrow("learning rate must be a positive number, got 0");
    expect(() => new SGD(params(), { lr: NaN })).toThrow(RangeError);
    expect(() => new SGD(params(), { momentum: 1 })).toThrow("momentum must be in [0, 1), got 1");
    const opt = new SGD(params());
    expect(() => (opt.lr = -1)).toThrow(RangeError);
    opt.lr = 0.3;
    expect(opt.lr).toBe(0.3);
  });
});

describe("Adam", () => {
  it("matches hand-computed values for two steps", () => {
    const [a, b] = params();
    const opt = new Adam([a, b], { lr: 0.1 });

    // Step 1, g = (0.5, -1):
    //   m = 0.1·g = (0.05, -0.1)           v = 0.001·g² = (0.00025, 0.001)
    //   m̂ = m / 0.1 = g                     v̂ = v / 0.001 = g²
    //   update = 0.1 · g / (|g| + 1e-8) ≈ 0.1 · sign(g)
    a.grad = 0.5;
    b.grad = -1;
    opt.step();
    expect(a.data).toBeCloseTo(0.900000002, 12);
    expect(b.data).toBeCloseTo(-1.900000001, 12);
    expect(opt.steps).toBe(1);

    // Step 2, g = (-1, 0):
    //   a: m = 0.9·0.05 - 0.1 = -0.055      v = 0.999·0.00025 + 0.001 = 0.00124975
    //      m̂ = -0.055 / 0.19 = -0.289474     v̂ = 0.00124975 / 0.001999 = 0.625188
    //      a = 0.9 + 0.1 · 0.289474 / 0.790688 = 0.936610
    //   b: m = -0.09, v = 0.000999, m̂ = -0.473684, v̂ = 0.499750
    //      b = -1.9 + 0.1 · 0.473684 / 0.706930 = -1.832994
    a.grad = -1;
    b.grad = 0;
    opt.step();
    expect(a.data).toBeCloseTo(0.9366103542, 9);
    expect(b.data).toBeCloseTo(-1.8329941765, 9);
  });

  it("validates betas", () => {
    expect(() => new Adam(params(), { beta1: 1 })).toThrow("beta1 must be in [0, 1), got 1");
    expect(() => new Adam(params(), { beta2: -0.1 })).toThrow("beta2 must be in [0, 1), got -0.1");
  });
});

describe("makeOptimizer", () => {
  it("builds SGD with momentum or Adam", () => {
    const sgd = makeOptimizer("sgd", params(), 0.05);
    expect(sgd).toBeInstanceOf(SGD);
    expect((sgd as SGD).momentum).toBe(0.9);
    expect(sgd.lr).toBe(0.05);
    const adam = makeOptimizer("adam", params(), 0.01);
    expect(adam).toBeInstanceOf(Adam);
    expect(adam.name).toBe("adam");
  });

  it.each(["sgd", "adam"] as const)("%s lowers the loss of a small regression", (name) => {
    const mlp = new MLP(1, [8, 1], { seed: 4 });
    const xs = [-1, -0.5, 0, 0.5, 1];
    const ys = xs.map((x) => x * x - 0.3);
    const opt = makeOptimizer(name, mlp.parameters(), 0.05);
    const lossAt = () => mse(xs.map((x) => mlp.forward([x])[0]!), ys);
    const first = lossAt().data;
    for (let i = 0; i < 200; i++) {
      const loss = lossAt();
      opt.zeroGrad();
      loss.backward();
      opt.step();
    }
    expect(lossAt().data).toBeLessThan(first * 0.1);
  });
});
