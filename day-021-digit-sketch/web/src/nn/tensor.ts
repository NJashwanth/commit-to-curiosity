/** A dense float32 tensor: a shape and a flat row-major buffer. Conv activations are [channels, height, width]. */
export interface Tensor {
  shape: number[];
  data: Float32Array;
}

export function sizeOf(shape: readonly number[]): number {
  return shape.reduce((a, b) => a * b, 1);
}

export function tensor(shape: number[], data?: ArrayLike<number>): Tensor {
  const n = sizeOf(shape);
  if (data === undefined) return { shape: [...shape], data: new Float32Array(n) };
  if (data.length !== n) throw new Error(`tensor of shape [${shape}] needs ${n} values, got ${data.length}`);
  return { shape: [...shape], data: Float32Array.from(data) };
}

export function sameShape(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
