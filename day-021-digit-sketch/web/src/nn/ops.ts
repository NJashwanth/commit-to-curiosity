/**
 * The neural network operations, written out as loops over Float32Arrays.
 * One image at a time: conv activations are [channels, height, width], dense activations are [features].
 * Layouts match PyTorch: conv weight [out, in, k, k], dense weight [out, in].
 */
import { Tensor, sizeOf } from "./tensor";

/** Valid (no padding), stride 1 convolution: [C, H, W] -> [O, H-k+1, W-k+1]. */
export function conv2d(input: Tensor, weight: Float32Array, bias: Float32Array, outChannels: number, kernel: number): Tensor {
  if (input.shape.length !== 3) throw new Error(`conv2d needs a [C, H, W] input, got [${input.shape}]`);
  const [inC, h, w] = input.shape;
  if (h < kernel || w < kernel) throw new Error(`conv2d: ${h}x${w} input is smaller than the ${kernel}x${kernel} kernel`);
  if (weight.length !== outChannels * inC * kernel * kernel) {
    throw new Error(`conv2d: weight has ${weight.length} values, expected ${outChannels * inC * kernel * kernel}`);
  }
  if (bias.length !== outChannels) throw new Error(`conv2d: bias has ${bias.length} values, expected ${outChannels}`);
  const oh = h - kernel + 1;
  const ow = w - kernel + 1;
  const out = new Float32Array(outChannels * oh * ow);
  const x = input.data;
  for (let o = 0; o < outChannels; o++) {
    for (let y = 0; y < oh; y++) {
      for (let xx = 0; xx < ow; xx++) {
        let sum = bias[o];
        for (let c = 0; c < inC; c++) {
          const wBase = ((o * inC + c) * kernel) * kernel;
          const xBase = c * h * w;
          for (let ky = 0; ky < kernel; ky++) {
            const xRow = xBase + (y + ky) * w + xx;
            const wRow = wBase + ky * kernel;
            for (let kx = 0; kx < kernel; kx++) sum += x[xRow + kx] * weight[wRow + kx];
          }
        }
        out[(o * oh + y) * ow + xx] = sum;
      }
    }
  }
  return { shape: [outChannels, oh, ow], data: out };
}

export function relu(input: Tensor): Tensor {
  const out = new Float32Array(input.data.length);
  for (let i = 0; i < out.length; i++) out[i] = input.data[i] > 0 ? input.data[i] : 0;
  return { shape: [...input.shape], data: out };
}

/** Non-overlapping max pooling. A trailing odd row or column is dropped, like PyTorch's floor mode. */
export function maxpool2d(input: Tensor, size: number): Tensor {
  if (input.shape.length !== 3) throw new Error(`maxpool2d needs a [C, H, W] input, got [${input.shape}]`);
  const [c, h, w] = input.shape;
  const oh = Math.floor(h / size);
  const ow = Math.floor(w / size);
  if (oh < 1 || ow < 1) throw new Error(`maxpool2d: ${h}x${w} input is smaller than the ${size}x${size} window`);
  const out = new Float32Array(c * oh * ow);
  for (let ch = 0; ch < c; ch++) {
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        let best = -Infinity;
        for (let dy = 0; dy < size; dy++) {
          for (let dx = 0; dx < size; dx++) {
            const v = input.data[(ch * h + y * size + dy) * w + x * size + dx];
            if (v > best) best = v;
          }
        }
        out[(ch * oh + y) * ow + x] = best;
      }
    }
  }
  return { shape: [c, oh, ow], data: out };
}

/** [C, H, W] -> [C*H*W], in the same channel-major order PyTorch's flatten uses. */
export function flatten(input: Tensor): Tensor {
  return { shape: [sizeOf(input.shape)], data: Float32Array.from(input.data) };
}

/** y = W x + b with W as [out, in]. */
export function dense(input: Tensor, weight: Float32Array, bias: Float32Array, outFeatures: number): Tensor {
  if (input.shape.length !== 1) throw new Error(`dense needs a flat input, got [${input.shape}]`);
  const inFeatures = input.shape[0];
  if (weight.length !== outFeatures * inFeatures) {
    throw new Error(`dense: weight has ${weight.length} values, expected ${outFeatures * inFeatures}`);
  }
  if (bias.length !== outFeatures) throw new Error(`dense: bias has ${bias.length} values, expected ${outFeatures}`);
  const out = new Float32Array(outFeatures);
  for (let o = 0; o < outFeatures; o++) {
    let sum = bias[o];
    const base = o * inFeatures;
    for (let i = 0; i < inFeatures; i++) sum += weight[base + i] * input.data[i];
    out[o] = sum;
  }
  return { shape: [outFeatures], data: out };
}

/** Numerically stable softmax: subtract the maximum before exponentiating. */
export function softmax(input: Tensor): Tensor {
  const n = input.data.length;
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (input.data[i] > max) max = input.data[i];
  const out = new Float32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.exp(input.data[i] - max);
    total += out[i];
  }
  for (let i = 0; i < n; i++) out[i] /= total;
  return { shape: [...input.shape], data: out };
}

export function argmax(values: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}
