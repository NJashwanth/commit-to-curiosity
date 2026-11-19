/** Optimizers: they read each parameter's grad and move its data. */
import type { Value } from "./engine";

export interface Optimizer {
  readonly name: OptimizerName;
  lr: number;
  step(): void;
  zeroGrad(): void;
}

export const OPTIMIZERS = ["sgd", "adam"] as const;
export type OptimizerName = (typeof OPTIMIZERS)[number];

function checkLr(lr: number): void {
  if (!(lr > 0) || !Number.isFinite(lr)) throw new RangeError(`learning rate must be a positive number, got ${lr}`);
}

abstract class BaseOptimizer {
  private _lr = 0;

  constructor(
    readonly params: readonly Value[],
    lr: number,
  ) {
    this.lr = lr;
  }

  get lr(): number {
    return this._lr;
  }

  set lr(value: number) {
    checkLr(value);
    this._lr = value;
  }

  zeroGrad(): void {
    for (const p of this.params) p.grad = 0;
  }
}

export interface SGDOptions {
  lr?: number;
  /** 0 is plain SGD. With momentum μ: v = μv + g; p -= lr·v. */
  momentum?: number;
}

export class SGD extends BaseOptimizer implements Optimizer {
  readonly name = "sgd";
  readonly momentum: number;
  private readonly velocity: Float64Array;

  constructor(params: readonly Value[], { lr = 0.1, momentum = 0 }: SGDOptions = {}) {
    super(params, lr);
    if (!(momentum >= 0 && momentum < 1)) throw new RangeError(`momentum must be in [0, 1), got ${momentum}`);
    this.momentum = momentum;
    this.velocity = new Float64Array(params.length);
  }

  step(): void {
    const { params, lr, momentum, velocity } = this;
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      const v = momentum * velocity[i]! + p.grad;
      velocity[i] = v;
      p.data -= lr * v;
    }
  }
}

export interface AdamOptions {
  lr?: number;
  beta1?: number;
  beta2?: number;
  eps?: number;
}

/**
 * Adam (Kingma & Ba, 2015). Keeps running averages of the gradient (m) and
 * its square (v), corrects their bias towards 0 in early steps, and moves each
 * parameter by lr · m̂ / (√v̂ + eps).
 */
export class Adam extends BaseOptimizer implements Optimizer {
  readonly name = "adam";
  readonly beta1: number;
  readonly beta2: number;
  readonly eps: number;
  private readonly m: Float64Array;
  private readonly v: Float64Array;
  private t = 0;

  constructor(params: readonly Value[], { lr = 0.01, beta1 = 0.9, beta2 = 0.999, eps = 1e-8 }: AdamOptions = {}) {
    super(params, lr);
    for (const [name, b] of [["beta1", beta1], ["beta2", beta2]] as const) {
      if (!(b >= 0 && b < 1)) throw new RangeError(`${name} must be in [0, 1), got ${b}`);
    }
    this.beta1 = beta1;
    this.beta2 = beta2;
    this.eps = eps;
    this.m = new Float64Array(params.length);
    this.v = new Float64Array(params.length);
  }

  /** How many steps have been taken. */
  get steps(): number {
    return this.t;
  }

  step(): void {
    const { params, lr, beta1, beta2, eps, m, v } = this;
    this.t++;
    const c1 = 1 - beta1 ** this.t;
    const c2 = 1 - beta2 ** this.t;
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      const g = p.grad;
      m[i] = beta1 * m[i]! + (1 - beta1) * g;
      v[i] = beta2 * v[i]! + (1 - beta2) * g * g;
      p.data -= (lr * (m[i]! / c1)) / (Math.sqrt(v[i]! / c2) + eps);
    }
  }
}

export function makeOptimizer(name: OptimizerName, params: readonly Value[], lr: number): Optimizer {
  return name === "adam" ? new Adam(params, { lr }) : new SGD(params, { lr, momentum: 0.9 });
}
