import { describe, expect, it } from "vitest";
import { AutogradError, Value, backward } from "../src/engine";
import {
  ACTIVATIONS,
  LOSS_FNS,
  Layer,
  MLP,
  Neuron,
  accuracy,
  activate,
  activateNumber,
  bce,
  hinge,
  l2,
  mse,
  zeroGrad,
} from "../src/nn";
import { gaussian, mulberry32, uniform } from "../src/rng";
import { gradCheck } from "./helpers";

describe("rng", () => {
  it("is deterministic per seed and in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(mulberry32(43)()).not.toBe(xs[0]);
  });

  it("gaussian has mean 0 and variance 1", () => {
    const rng = mulberry32(7);
    const xs = Array.from({ length: 20000 }, () => gaussian(rng));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });

  it("uniform stays in range", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const x = uniform(rng, -2, 3);
      expect(x).toBeGreaterThanOrEqual(-2);
      expect(x).toBeLessThan(3);
    }
  });
});

describe("activations", () => {
  it("Value and number versions agree", () => {
    for (const act of ACTIVATIONS) {
      for (const x of [-2.5, -0.1, 0, 0.3, 4]) {
        expect(activate(new Value(x), act).data).toBeCloseTo(activateNumber(x, act), 14);
      }
    }
  });

  it("linear is the identity, without a new node", () => {
    const v = new Value(3);
    expect(activate(v, "linear")).toBe(v);
  });
});

describe("Neuron, Layer, MLP", () => {
  it("a neuron computes act(w·x + b)", () => {
    const n = new Neuron(3, "tanh", mulberry32(1));
    n.w.forEach((w, i) => (w.data = [0.5, -1, 2][i]!));
    n.b.data = 0.25;
    expect(n.forward([1, 2, 3]).data).toBeCloseTo(Math.tanh(0.5 - 2 + 6 + 0.25), 14);
    expect(n.predict([1, 2, 3])).toBeCloseTo(Math.tanh(4.75), 14);
    expect(n.parameters()).toHaveLength(4);
  });

  it("rejects the wrong number of inputs", () => {
    expect(() => new Neuron(2, "relu", mulberry32(1)).forward([1])).toThrow("Neuron expects 2 inputs, got 1");
    expect(() => new MLP(2, [4, 1]).forward([1, 2, 3])).toThrow(AutogradError);
  });

  it("initialises weights in a fan-in scaled range and biases at 0", () => {
    const tanhLayer = new Layer(12, 50, "tanh", mulberry32(3));
    const reluLayer = new Layer(12, 50, "relu", mulberry32(3));
    for (const n of tanhLayer.neurons) {
      expect(n.b.data).toBe(0);
      for (const w of n.w) expect(Math.abs(w.data)).toBeLessThanOrEqual(Math.sqrt(3 / 12));
    }
    const maxRelu = Math.max(...reluLayer.neurons.flatMap((n) => n.w.map((w) => Math.abs(w.data))));
    expect(maxRelu).toBeGreaterThan(Math.sqrt(3 / 12));
    expect(maxRelu).toBeLessThanOrEqual(Math.sqrt(6 / 12));
  });

  it.each([
    [2, [16, 16, 1], 2 * 16 + 16 + 16 * 16 + 16 + 16 + 1],
    [3, [4, 4, 1], 41],
    [2, [1], 3],
    [2, [8, 8, 8, 1], 24 + 72 + 72 + 9],
  ])("parameter count of %i-%j", (nin, sizes, expected) => {
    const mlp = new MLP(nin, sizes);
    expect(mlp.paramCount).toBe(expected);
    expect(mlp.parameters()).toHaveLength(expected);
    expect(new Set(mlp.parameters()).size).toBe(expected);
    expect(mlp.shape).toEqual([nin, ...sizes]);
  });

  it("2-16-16-1 has 337 parameters", () => {
    expect(new MLP(2, [16, 16, 1]).paramCount).toBe(337);
    expect(String(new MLP(2, [16, 16, 1], { activation: "relu" }))).toBe("MLP(2-16-16-1, relu, 337 params)");
  });

  it("rejects bad layer sizes", () => {
    expect(() => new MLP(2, [])).toThrow(/positive integers/);
    expect(() => new MLP(2, [0, 1])).toThrow("MLP layer sizes must be positive integers, got 2-0-1");
    expect(() => new MLP(2, [1.5])).toThrow(AutogradError);
  });

  it("uses the hidden activation inside and the output activation last", () => {
    const mlp = new MLP(2, [5, 3], { activation: "relu", outputActivation: "sigmoid" });
    expect(mlp.layers[0]!.neurons.every((n) => n.activation === "relu")).toBe(true);
    expect(mlp.layers[1]!.neurons.every((n) => n.activation === "sigmoid")).toBe(true);
    const out = mlp.forward([0.3, -0.7]);
    expect(out).toHaveLength(3);
    for (const o of out) expect(o.data).toBeGreaterThan(0);
    expect(new MLP(2, [4, 1]).layers[1]!.neurons[0]!.activation).toBe("linear");
  });

  it("predict() on numbers matches forward() on Values", () => {
    for (const act of ACTIVATIONS) {
      const mlp = new MLP(2, [7, 6, 2], { activation: act, seed: 5 });
      const x = [0.4, -1.3];
      expect(mlp.predict(x)).toEqual(mlp.forward(x).map((v) => v.data));
    }
  });

  it("the same seed gives the same weights", () => {
    const a = new MLP(2, [4, 1], { seed: 9 }).parameters().map((p) => p.data);
    const b = new MLP(2, [4, 1], { seed: 9 }).parameters().map((p) => p.data);
    const c = new MLP(2, [4, 1], { seed: 10 }).parameters().map((p) => p.data);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("gradients through a whole MLP match finite differences", () => {
    const mlp = new MLP(2, [3, 1], { seed: 2 });
    const params = mlp.parameters();
    const start = params.map((p) => p.data);
    gradCheck(
      (vs) => {
        // Rebuild the forward pass by hand with the given parameter Values.
        let k = 0;
        let h: Value[] = [new Value(0.5), new Value(-0.8)];
        for (const layer of mlp.layers) {
          h = layer.neurons.map((n) => {
            const terms = n.w.map((_, i) => vs[k++]!.mul(h[i]!));
            terms.push(vs[k++]!);
            return activate(Value.sum(terms), n.activation);
          });
        }
        return h[0]!.sub(1).pow(2);
      },
      start,
      1e-5,
    );
  });

  it("zeroGrad clears every parameter's grad", () => {
    const mlp = new MLP(2, [4, 4, 1]);
    mse(mlp.forward([1, -1]), [1]).backward();
    expect(mlp.parameters().some((p) => p.grad !== 0)).toBe(true);
    mlp.zeroGrad();
    expect(mlp.parameters().every((p) => p.grad === 0)).toBe(true);
    mse(mlp.forward([1, -1]), [1]).backward();
    zeroGrad(mlp.layers[0]!);
    expect(mlp.layers[0]!.parameters().every((p) => p.grad === 0)).toBe(true);
    expect(mlp.layers[1]!.parameters().some((p) => p.grad !== 0)).toBe(true);
  });

  it("backward on the raw multi-output list is rejected", () => {
    const outs = new MLP(2, [3, 2]).forward([1, 2]);
    expect(() => backward(outs)).toThrow(/array of 2 values/);
  });
});

describe("losses", () => {
  const scores = () => [new Value(0.8), new Value(-0.4), new Value(2.5), new Value(-1.2)];
  const labels = [1, 1, -1, -1];

  it("mse matches a hand computation", () => {
    // (0.8-1)² + (-0.4-1)² + (2.5+1)² + (-1.2+1)² = 0.04 + 1.96 + 12.25 + 0.04
    expect(mse(scores(), labels).data).toBeCloseTo(14.29 / 4, 12);
  });

  it("hinge matches a hand computation", () => {
    // relu(1-0.8) + relu(1+0.4) + relu(1+2.5) + relu(1-1.2) = 0.2 + 1.4 + 3.5 + 0
    expect(hinge(scores(), labels).data).toBeCloseTo(5.1 / 4, 12);
  });

  it("bce matches -log(sigmoid) for ±1 labels", () => {
    const expected = [0.8, -0.4, -2.5, 1.2].map((m) => Math.log(1 + Math.exp(-m)));
    expect(bce(scores(), labels).data).toBeCloseTo(expected.reduce((s, x) => s + x) / 4, 12);
  });

  it("bce stays finite for huge scores", () => {
    const loss = bce([new Value(500), new Value(-500)], [-1, 1]);
    expect(loss.data).toBeCloseTo(500, 9);
    expect(bce([new Value(800)], [1]).data).toBe(0);
  });

  it.each(Object.entries(LOSS_FNS))("%s gradients match finite differences", (_, loss) => {
    gradCheck((vs) => loss(vs, labels), [0.8, -0.4, 2.5, -1.2]);
  });

  it("bce's gradient is (sigmoid(z) - t) / n", () => {
    const z = new Value(0.7);
    bce([z], [1]).backward();
    expect(z.grad).toBeCloseTo(1 / (1 + Math.exp(-0.7)) - 1, 12);
  });

  it("rejects empty and mismatched batches", () => {
    expect(() => mse([], [])).toThrow("loss needs at least one prediction");
    expect(() => hinge([new Value(1)], [1, -1])).toThrow("loss got 1 predictions but 2 labels");
  });

  it("l2 is lambda · Σ p², with gradient 2·lambda·p", () => {
    const ps = [new Value(1), new Value(-2), new Value(3)];
    const reg = l2(ps, 0.01);
    expect(reg.data).toBeCloseTo(0.14, 12);
    reg.backward();
    expect(ps.map((p) => p.grad)).toEqual([0.02, -0.04, 0.06].map((g) => expect.closeTo(g, 12)));
    expect(l2(ps, 0).data).toBe(0);
  });

  it("accuracy counts sign matches", () => {
    expect(accuracy([0.5, -0.1, 2, -3], [1, 1, 1, -1])).toBe(0.75);
    expect(accuracy([0], [-1])).toBe(1);
    expect(accuracy([], [])).toBe(0);
  });
});
