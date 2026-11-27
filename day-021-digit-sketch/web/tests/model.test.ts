import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORMAT, Model, fetchModel, loadModel, ModelSpec } from "../src/nn/model";
import { tensor } from "../src/nn/tensor";

const modelPath = new URL("../public/model.json", import.meta.url);
const modelText = readFileSync(modelPath, "utf8");
const spec = JSON.parse(modelText) as ModelSpec;
const fwd = JSON.parse(readFileSync(new URL("./fixtures/forward.json", import.meta.url), "utf8"));
const model = loadModel(spec);

describe("the full forward pass matches PyTorch on 20 fixture images", () => {
  it("the fixtures were generated for this exact model.json", () => {
    expect(createHash("sha256").update(modelText).digest("hex").slice(0, 16)).toBe(fwd.model_fingerprint);
    expect(fwd.images).toHaveLength(20);
    expect(new Set(fwd.labels).size).toBe(10);
  });

  it("normalization constants agree with the training side", () => {
    expect(spec.input.mean).toBe(fwd.mean);
    expect(spec.input.std).toBe(fwd.std);
  });

  it.each(Array.from({ length: 20 }, (_, i) => i))("image %i: same prediction and probabilities", (i) => {
    const pixels = (fwd.images[i] as number[]).map((v) => v / 255);
    const p = model.predict(pixels);
    expect(p.label).toBe(fwd.predictions[i]);
    expect(p.confidence).toBeCloseTo(fwd.probs[i][p.label], 4);
    for (let d = 0; d < 10; d++) expect(Math.abs(p.probs[d] - fwd.probs[i][d])).toBeLessThan(1e-4);
    expect(Array.from(p.probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it("recognises the digits (the fixtures are real test images)", () => {
    const correct = fwd.images.filter((img: number[], i: number) => model.predict(img.map((v) => v / 255)).label === fwd.labels[i]);
    expect(correct.length).toBeGreaterThanOrEqual(19);
  });
});

describe("model structure", () => {
  it("follows the architecture in the file", () => {
    expect(spec.format).toBe(FORMAT);
    expect(model.shapes).toEqual([
      [16, 26, 26], [16, 26, 26], [16, 13, 13], [32, 11, 11], [32, 11, 11], [32, 5, 5], [800], [64], [64], [10], [10],
    ]);
    expect(model.classes).toBe(10);
    expect(spec.meta.params).toBe(56714);
  });

  it("exposes the post-ReLU conv feature maps", () => {
    const p = model.predict(new Float32Array(784));
    const [c1, c2] = model.convMaps(p.activations);
    expect(c1.shape).toEqual([16, 26, 26]);
    expect(c2.shape).toEqual([32, 11, 11]);
    expect(Math.min(...c1.data)).toBeGreaterThanOrEqual(0);
    expect(p.activations).toHaveLength(spec.layers.length);
  });

  it("convMaps falls back to the raw conv output when no ReLU follows", () => {
    const tiny = loadModel({
      format: FORMAT, version: 1, meta: {}, input: { shape: [1, 3, 3], mean: 0, std: 1 },
      layers: [{ type: "conv2d", in: 1, out: 1, kernel: 3, weight: new Array(9).fill(1), bias: [-100] }],
    } as ModelSpec);
    const p = tiny.forward(tiny.normalize(new Float32Array(9)));
    expect(tiny.convMaps(p.activations)[0].data[0]).toBe(-100); // negative: proves it is not ReLU'd
  });

  it("is deterministic and rejects wrong input sizes", () => {
    const px = (fwd.images[3] as number[]).map((v) => v / 255);
    expect(Array.from(model.predict(px).probs)).toEqual(Array.from(model.predict(px).probs));
    expect(() => model.predict(new Float32Array(783))).toThrow(/expected 784 pixels/);
    expect(() => model.forward(tensor([1, 20, 20]))).toThrow(/does not match/);
  });
});

describe("loading and validating model files", () => {
  const clone = () => JSON.parse(modelText) as ModelSpec;

  it("rejects files that are not this format", () => {
    expect(() => loadModel({ format: "onnx" })).toThrow(/format/);
    expect(() => loadModel(null)).toThrow(/format/);
    const noLayers = clone();
    noLayers.layers = [];
    expect(() => new Model(noLayers)).toThrow(/no layers/);
    const badInput = clone();
    badInput.input.std = 0;
    expect(() => new Model(badInput)).toThrow(/input needs/);
  });

  it("catches inconsistent weights and shapes with a message naming the layer", () => {
    const short = clone();
    (short.layers[0] as any).weight = (short.layers[0] as any).weight.slice(1);
    expect(() => new Model(short)).toThrow(/layer 0 \(conv2d\) weight has 143 values, expected 144/);

    const notArray = clone();
    (notArray.layers[0] as any).bias = "oops";
    expect(() => new Model(notArray)).toThrow(/bias is not an array/);

    const wrongChannels = clone();
    (wrongChannels.layers[3] as any).in = 8;
    expect(() => new Model(wrongChannels)).toThrow(/layer 3 \(conv2d\) expects 8 input channels/);

    const wrongDense = clone();
    (wrongDense.layers[7] as any).in = 799;
    expect(() => new Model(wrongDense)).toThrow(/layer 7 \(dense\) expects 799 inputs/);

    const unknown = clone();
    (unknown.layers[1] as any).type = "tanh";
    expect(() => new Model(unknown)).toThrow(/unknown type/);

    const tooSmall = clone();
    tooSmall.layers.splice(3, 0, { type: "maxpool", size: 20 } as any);
    expect(() => new Model(tooSmall)).toThrow(/cannot pool/);

    const bigKernel = clone();
    (bigKernel.layers[0] as any).kernel = 30;
    (bigKernel.layers[0] as any).weight = new Array(16 * 900).fill(0);
    expect(() => new Model(bigKernel)).toThrow(/smaller than the kernel/);
  });

  it("fetchModel loads from a URL and reports HTTP errors", async () => {
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string) =>
        url.endsWith("ok.json")
          ? new Response(modelText, { status: 200 })
          : new Response("nope", { status: 404 })) as typeof fetch;
      expect((await fetchModel("/ok.json")).classes).toBe(10);
      await expect(fetchModel("/missing.json")).rejects.toThrow(/HTTP 404/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
