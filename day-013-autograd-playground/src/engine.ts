/**
 * A scalar autograd engine.
 *
 * Every arithmetic operation on a `Value` returns a new `Value` that remembers
 * its inputs (`parents`) and the operation that produced it (`op`). Calling
 * `backward()` on the final value walks that graph in reverse topological
 * order and applies the chain rule, adding each node's contribution into the
 * `grad` of its parents.
 */

export type Op =
  | ""
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "neg"
  | "exp"
  | "log"
  | "tanh"
  | "relu"
  | "sigmoid"
  | "sum";

/** Thrown for anything the engine refuses to compute. */
export class AutogradError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutogradError";
  }
}

export type Scalar = number | Value;

/** A global visit counter, so topological sorts don't need a Set per call. */
let epoch = 0;

const fmt = (x: number): string => String(Number(x.toPrecision(6)));

export class Value {
  data: number;
  grad = 0;
  readonly parents: readonly Value[];
  readonly op: Op;
  /** The constant exponent for `^` with a plain-number power. */
  readonly exponent: number;
  label: string;
  private mark = 0;

  constructor(data: number, parents: readonly Value[] = [], op: Op = "", label = "", exponent = NaN) {
    if (!Number.isFinite(data)) {
      const where = op ? `${op} produced` : "Value got";
      throw new AutogradError(`${where} a non-finite number (${data}); every Value must hold a finite number`);
    }
    this.data = data;
    this.parents = parents;
    this.op = op;
    this.label = label;
    this.exponent = exponent;
  }

  static from(x: Scalar): Value {
    return x instanceof Value ? x : new Value(x);
  }

  /** Adds any number of values in one node, so long sums don't make deep graphs. */
  static sum(xs: readonly Scalar[]): Value {
    if (xs.length === 0) return new Value(0);
    const parents = xs.map(Value.from);
    let total = 0;
    for (const p of parents) total += p.data;
    return new Value(total, parents, "sum");
  }

  add(other: Scalar): Value {
    const o = Value.from(other);
    return new Value(this.data + o.data, [this, o], "+");
  }

  sub(other: Scalar): Value {
    const o = Value.from(other);
    return new Value(this.data - o.data, [this, o], "-");
  }

  mul(other: Scalar): Value {
    const o = Value.from(other);
    return new Value(this.data * o.data, [this, o], "*");
  }

  div(other: Scalar): Value {
    const o = Value.from(other);
    if (o.data === 0) {
      throw new AutogradError(`Division by zero: ${fmt(this.data)} / 0 (the divisor's value is 0)`);
    }
    return new Value(this.data / o.data, [this, o], "/");
  }

  /**
   * Raises this value to a power. A plain number exponent is a constant;
   * a `Value` exponent also gets a gradient (d/db a^b = a^b ln a), which only
   * exists for a positive base.
   */
  pow(power: Scalar): Value {
    const a = this.data;
    if (power instanceof Value) {
      if (a <= 0) {
        throw new AutogradError(
          `pow with a variable exponent needs a positive base, got ${fmt(a)} ^ ${fmt(power.data)}`,
        );
      }
      return new Value(a ** power.data, [this, power], "^");
    }
    if (a === 0 && power < 0) {
      throw new AutogradError(`Division by zero: 0 ^ ${fmt(power)}`);
    }
    if (a < 0 && !Number.isInteger(power)) {
      throw new AutogradError(`pow of a negative base needs an integer exponent, got ${fmt(a)} ^ ${fmt(power)}`);
    }
    return new Value(a ** power, [this], "^", "", power);
  }

  neg(): Value {
    return new Value(-this.data, [this], "neg");
  }

  exp(): Value {
    return new Value(Math.exp(this.data), [this], "exp");
  }

  log(): Value {
    if (this.data <= 0) {
      throw new AutogradError(`log of a non-positive value: log(${fmt(this.data)}) is undefined (input must be > 0)`);
    }
    return new Value(Math.log(this.data), [this], "log");
  }

  tanh(): Value {
    return new Value(Math.tanh(this.data), [this], "tanh");
  }

  relu(): Value {
    return new Value(this.data > 0 ? this.data : 0, [this], "relu");
  }

  sigmoid(): Value {
    return new Value(sigmoid(this.data), [this], "sigmoid");
  }

  /**
   * Every node reachable from this one, inputs before the nodes that use them,
   * each exactly once. Iterative, so deep graphs can't overflow the stack.
   */
  topo(): Value[] {
    const visit = ++epoch;
    const order: Value[] = [];
    const nodes: Value[] = [this];
    const next: number[] = [0];
    this.mark = visit;
    while (nodes.length > 0) {
      const top = nodes.length - 1;
      const node = nodes[top]!;
      const i = next[top]!;
      if (i < node.parents.length) {
        next[top] = i + 1;
        const p = node.parents[i]!;
        if (p.mark !== visit) {
          p.mark = visit;
          nodes.push(p);
          next.push(0);
        }
      } else {
        nodes.pop();
        next.pop();
        order.push(node);
      }
    }
    return order;
  }

  /**
   * Backpropagates from this value: sets its grad to 1, then visits the graph
   * in reverse topological order so every node's grad is complete before it is
   * pushed to its parents. Grads add up (`+=`), so a node used twice gets both
   * contributions. Call `zeroGrad` on the parameters between steps.
   */
  backward(): void {
    const order = this.topo();
    this.grad = 1;
    for (let i = order.length - 1; i >= 0; i--) order[i]!.propagate();
  }

  /** Pushes this node's grad to its parents using the local derivative of `op`. */
  private propagate(): void {
    const g = this.grad;
    const ps = this.parents;
    switch (this.op) {
      case "":
        return;
      case "+":
        ps[0]!.grad += g;
        ps[1]!.grad += g;
        return;
      case "-":
        ps[0]!.grad += g;
        ps[1]!.grad -= g;
        return;
      case "*": {
        const [a, b] = ps as [Value, Value];
        a.grad += b.data * g;
        b.grad += a.data * g;
        return;
      }
      case "/": {
        const [a, b] = ps as [Value, Value];
        a.grad += g / b.data;
        b.grad -= (a.data / (b.data * b.data)) * g;
        return;
      }
      case "^": {
        const a = ps[0]!;
        if (ps.length === 1) {
          const k = this.exponent;
          a.grad += k * a.data ** (k - 1) * g;
        } else {
          const b = ps[1]!;
          a.grad += b.data * a.data ** (b.data - 1) * g;
          b.grad += this.data * Math.log(a.data) * g;
        }
        return;
      }
      case "neg":
        ps[0]!.grad -= g;
        return;
      case "exp":
        ps[0]!.grad += this.data * g;
        return;
      case "log":
        ps[0]!.grad += g / ps[0]!.data;
        return;
      case "tanh":
        ps[0]!.grad += (1 - this.data * this.data) * g;
        return;
      case "relu":
        if (this.data > 0) ps[0]!.grad += g;
        return;
      case "sigmoid":
        ps[0]!.grad += this.data * (1 - this.data) * g;
        return;
      case "sum":
        for (const p of ps) p.grad += g;
        return;
    }
  }

  toString(): string {
    const name = this.label ? `${this.label}, ` : "";
    return `Value(${name}data=${fmt(this.data)}, grad=${fmt(this.grad)})`;
  }
}

/** A sigmoid that doesn't overflow for large negative inputs. */
export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/**
 * Runs backprop from `output`, refusing anything that isn't one scalar Value.
 * Gradients are only defined for a scalar output: for a list such as an MLP's
 * raw outputs, reduce it to one number (a loss, or `Value.sum`) first.
 */
export function backward(output: unknown): void {
  if (Array.isArray(output)) {
    throw new AutogradError(
      `backward() needs a single scalar Value, but got an array of ${output.length} values. ` +
        "Reduce them to one number first, for example with a loss or Value.sum().",
    );
  }
  if (!(output instanceof Value)) {
    throw new AutogradError(`backward() needs a single scalar Value, but got ${typeof output}`);
  }
  output.backward();
}

/** Sets every grad in the graph under `output` back to zero. */
export function zeroGraph(output: Value): void {
  for (const v of output.topo()) v.grad = 0;
}
