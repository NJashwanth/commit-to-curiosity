import { describe, expect, it } from "vitest";
import { AutogradError, Value, backward, sigmoid, zeroGraph } from "../src/engine";
import { gradCheck } from "./helpers";

describe("forward values", () => {
  it("computes every op", () => {
    const a = new Value(3);
    const b = new Value(-2);
    expect(a.add(b).data).toBe(1);
    expect(a.sub(b).data).toBe(5);
    expect(a.mul(b).data).toBe(-6);
    expect(a.div(b).data).toBe(-1.5);
    expect(a.pow(2).data).toBe(9);
    expect(a.pow(new Value(0.5)).data).toBeCloseTo(Math.sqrt(3), 12);
    expect(a.neg().data).toBe(-3);
    expect(b.exp().data).toBeCloseTo(Math.exp(-2), 12);
    expect(a.log().data).toBeCloseTo(Math.log(3), 12);
    expect(b.tanh().data).toBeCloseTo(Math.tanh(-2), 12);
    expect(a.relu().data).toBe(3);
    expect(b.relu().data).toBe(0);
    expect(b.sigmoid().data).toBeCloseTo(1 / (1 + Math.exp(2)), 12);
    expect(Value.sum([a, b, 4]).data).toBe(5);
    expect(Value.sum([]).data).toBe(0);
  });

  it("accepts plain numbers on either side through Value.from", () => {
    expect(new Value(2).add(3).data).toBe(5);
    expect(Value.from(4).mul(new Value(0.5)).data).toBe(2);
    const v = new Value(1);
    expect(Value.from(v)).toBe(v);
  });

  it("records parents and op", () => {
    const a = new Value(1);
    const b = new Value(2);
    const c = a.mul(b);
    expect(c.op).toBe("*");
    expect(c.parents).toEqual([a, b]);
    expect(a.op).toBe("");
    expect(a.parents).toEqual([]);
    expect(a.pow(3).exponent).toBe(3);
  });

  it("sigmoid is stable at both extremes", () => {
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(new Value(-800).sigmoid().data).toBe(0);
  });

  it("prints a readable summary", () => {
    const v = new Value(1 / 3, [], "", "x");
    v.grad = 2;
    expect(String(v)).toBe("Value(x, data=0.333333, grad=2)");
    expect(String(new Value(1))).toBe("Value(data=1, grad=0)");
  });
});

describe("gradients match finite differences", () => {
  it("add, sub, mul, div", () => {
    gradCheck(([a, b]) => a!.add(b!), [1.5, -0.7]);
    gradCheck(([a, b]) => a!.sub(b!), [1.5, -0.7]);
    gradCheck(([a, b]) => a!.mul(b!), [1.5, -0.7]);
    gradCheck(([a, b]) => a!.div(b!), [1.5, -0.7]);
  });

  it("pow with a constant and with a variable exponent", () => {
    gradCheck(([a]) => a!.pow(3), [1.3]);
    gradCheck(([a]) => a!.pow(-2), [0.8]);
    gradCheck(([a]) => a!.pow(0.5), [2.0]);
    gradCheck(([a]) => a!.pow(2), [-1.7]);
    gradCheck(([a, b]) => a!.pow(b!), [1.7, 2.3]);
    gradCheck(([a, b]) => a!.pow(b!), [0.4, -1.1]);
  });

  it("neg, exp, log, tanh, sigmoid", () => {
    gradCheck(([a]) => a!.neg(), [0.9]);
    gradCheck(([a]) => a!.exp(), [0.9]);
    gradCheck(([a]) => a!.log(), [0.9]);
    gradCheck(([a]) => a!.tanh(), [0.9]);
    gradCheck(([a]) => a!.tanh(), [-2.5]);
    gradCheck(([a]) => a!.sigmoid(), [0.9]);
    gradCheck(([a]) => a!.sigmoid(), [-3.2]);
  });

  it("relu on both sides of the kink", () => {
    expect(gradCheck(([a]) => a!.relu(), [0.9])).toEqual([1]);
    expect(gradCheck(([a]) => a!.relu(), [-0.9])).toEqual([0]);
  });

  it("relu has zero gradient exactly at 0", () => {
    const a = new Value(0);
    a.relu().backward();
    expect(a.grad).toBe(0);
  });

  it("n-ary sum", () => {
    expect(gradCheck(([a, b, c]) => Value.sum([a!, b!, c!, 2]), [1, 2, 3])).toEqual([1, 1, 1]);
  });

  it("tanh(a*b + c), the graph viewer's default", () => {
    const [ga, gb, gc] = gradCheck(([a, b, c]) => a!.mul(b!).add(c!).tanh(), [2, -0.5, 0.25]);
    const local = 1 - Math.tanh(-0.75) ** 2;
    expect(ga).toBeCloseTo(-0.5 * local, 12);
    expect(gb).toBeCloseTo(2 * local, 12);
    expect(gc).toBeCloseTo(local, 12);
  });

  it("a long chained expression using every op", () => {
    gradCheck(
      ([a, b, c]) => {
        const d = a!.mul(b!).add(b!.pow(3)).sub(c!.exp());
        const e = d.div(c!.add(2)).neg().tanh();
        const f = e.add(a!.sigmoid().log()).mul(d.relu().add(1));
        const g = Value.sum([f, f.pow(2), a!.pow(c!)]);
        return g.div(3).sub(b!.neg().exp().log());
      },
      [1.2, -0.8, 0.6],
      1e-5,
    );
  });

  it("micrograd's sanity check expression", () => {
    // From micrograd's test_more_ops, where PyTorch is the reference.
    const a0 = new Value(-4);
    const b0 = new Value(2);
    let c = a0.add(b0);
    let d = a0.mul(b0).add(b0.pow(3));
    c = c.add(c.add(1));
    c = c.add(1).add(c).add(a0.neg());
    d = d.add(d.mul(2).add(b0.add(a0).relu()));
    d = d.add(d.mul(3).add(b0.sub(a0).relu()));
    const e = c.sub(d);
    const f = e.pow(2);
    let g = f.div(2);
    g = g.add(new Value(10).div(f));
    g.backward();
    expect(g.data).toBeCloseTo(24.70408163265306, 10);
    expect(a0.grad).toBeCloseTo(138.83381924198252, 10);
    expect(b0.grad).toBeCloseTo(645.5772594752186, 10);
  });
});

describe("reused nodes accumulate gradient", () => {
  it("a * a", () => {
    const a = new Value(3);
    a.mul(a).backward();
    expect(a.grad).toBe(6);
  });

  it("a + a", () => {
    const a = new Value(3);
    a.add(a).backward();
    expect(a.grad).toBe(2);
  });

  it("a - a and a / a are flat", () => {
    const a = new Value(3);
    a.sub(a).backward();
    expect(a.grad).toBe(0);
    const b = new Value(3);
    b.div(b).backward();
    expect(b.grad).toBeCloseTo(0, 15);
  });

  it("a node feeding two branches gets both contributions", () => {
    const a = new Value(-2);
    const b = new Value(3);
    const d = a.mul(b);
    const e = a.add(b);
    const f = d.mul(e);
    f.backward();
    // f = (ab)(a + b) = a²b + ab²; df/da = 2ab + b², df/db = a² + 2ab
    expect(a.grad).toBe(2 * -2 * 3 + 9);
    expect(b.grad).toBe(4 + 2 * -2 * 3);
  });

  it("the same node listed twice in a sum", () => {
    const a = new Value(1);
    Value.sum([a, a, a]).backward();
    expect(a.grad).toBe(3);
  });

  it("calling backward twice adds up until grads are zeroed", () => {
    const a = new Value(2);
    const b = a.mul(5);
    b.backward();
    b.backward();
    expect(a.grad).toBe(10);
    zeroGraph(b);
    expect(a.grad).toBe(0);
    expect(b.grad).toBe(0);
  });
});

describe("topological order", () => {
  it("visits each node exactly once, inputs first", () => {
    const a = new Value(1, [], "", "a");
    const b = new Value(2, [], "", "b");
    const c = a.mul(b);
    const d = a.add(c);
    const e = c.mul(d).add(a);
    const order = e.topo();
    expect(order).toHaveLength(new Set(order).size);
    expect(new Set(order)).toEqual(new Set([a, b, c, d, e, e.parents[0]!]));
    for (const node of order) {
      for (const p of node.parents) expect(order.indexOf(p)).toBeLessThan(order.indexOf(node));
    }
    expect(order.at(-1)).toBe(e);
  });

  it("handles a 100,000-deep chain without overflowing the stack", () => {
    const x = new Value(1);
    let y = x;
    for (let i = 0; i < 100_000; i++) y = y.add(0);
    expect(y.topo()).toHaveLength(200_001);
    y.backward();
    expect(x.grad).toBe(1);
  });

  it("repeated sorts don't see each other's visits", () => {
    const a = new Value(1);
    const b = a.add(a);
    expect(b.topo()).toHaveLength(2);
    expect(b.topo()).toHaveLength(2);
    expect(a.topo()).toEqual([a]);
  });
});

describe("clear errors", () => {
  it("rejects backward on a non-scalar output", () => {
    const outs = [new Value(1), new Value(2)];
    expect(() => backward(outs)).toThrow(AutogradError);
    expect(() => backward(outs)).toThrow(/single scalar Value, but got an array of 2 values/);
    expect(() => backward(3)).toThrow(/single scalar Value, but got number/);
  });

  it("backward() on a scalar works through the free function", () => {
    const a = new Value(2);
    backward(a.mul(a));
    expect(a.grad).toBe(4);
  });

  it("division by zero", () => {
    expect(() => new Value(1).div(0)).toThrow(AutogradError);
    expect(() => new Value(1).div(new Value(0))).toThrow("Division by zero: 1 / 0");
    expect(() => new Value(0).pow(-1)).toThrow("Division by zero: 0 ^ -1");
  });

  it("log of zero or a negative number", () => {
    expect(() => new Value(0).log()).toThrow("log of a non-positive value: log(0) is undefined (input must be > 0)");
    expect(() => new Value(-2).log()).toThrow(/log\(-2\)/);
  });

  it("pow outside its domain", () => {
    expect(() => new Value(-8).pow(1 / 3)).toThrow(/negative base needs an integer exponent/);
    expect(() => new Value(-2).pow(new Value(2))).toThrow(/variable exponent needs a positive base/);
    expect(() => new Value(0).pow(new Value(2))).toThrow(AutogradError);
  });

  it("non-finite numbers", () => {
    expect(() => new Value(NaN)).toThrow("Value got a non-finite number (NaN)");
    expect(() => new Value(Infinity)).toThrow(AutogradError);
    expect(() => new Value(1000).exp()).toThrow("exp produced a non-finite number (Infinity)");
    expect(() => new Value(1e200).mul(1e200)).toThrow(/\* produced/);
  });
});
