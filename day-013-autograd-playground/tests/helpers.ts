import { expect } from "vitest";
import { Value } from "../src/engine";

/**
 * Compares the engine's gradients with central finite differences:
 * df/dx ≈ (f(x + h) - f(x - h)) / 2h, evaluated with plain numbers.
 */
export function gradCheck(f: (xs: Value[]) => Value, inputs: number[], tol = 1e-6, h = 1e-6): number[] {
  const vs = inputs.map((x) => new Value(x));
  const out = f(vs);
  out.backward();
  const analytic = vs.map((v) => v.grad);
  inputs.forEach((_, i) => {
    const plus = inputs.slice();
    const minus = inputs.slice();
    plus[i]! += h;
    minus[i]! -= h;
    const fp = f(plus.map((x) => new Value(x))).data;
    const fm = f(minus.map((x) => new Value(x))).data;
    const numeric = (fp - fm) / (2 * h);
    const scale = Math.max(1, Math.abs(numeric));
    expect(Math.abs(analytic[i]! - numeric) / scale, `d/dx${i}: analytic ${analytic[i]} vs numeric ${numeric}`).toBeLessThan(tol);
  });
  return analytic;
}
