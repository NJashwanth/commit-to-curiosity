import { describe, expect, it } from "vitest";
import { Adam, SGD } from "../src/optim";
import { DEFAULT_CONFIG, Trainer, parseShape, train, validateConfig, type TrainConfig } from "../src/train";

describe("parseShape", () => {
  it.each([
    ["2-16-16-1", [2, 16, 16, 1]],
    [" 2 - 8 - 1 ", [2, 8, 1]],
    ["2,4,1", [2, 4, 1]],
    ["2x32x1", [2, 32, 1]],
    ["2 1", [2, 1]],
    ["2-64-64-64-64-1", [2, 64, 64, 64, 64, 1]],
  ])("parses %j", (text, expected) => {
    expect(parseShape(text)).toEqual(expected);
  });

  it.each([
    ["", /numbers separated by dashes/],
    ["2-a-1", /numbers separated by dashes, like 2-16-16-1; got "2-a-1"/],
    ["2--1", /numbers separated/],
    ["2-1.5-1", /numbers separated/],
    ["2", "shape needs at least an input and an output size, like 2-1"],
    ["3-8-1", "the first size is the input and must be 2 (x and y), got 3"],
    ["2-8-2", "the last size is the output score and must be 1, got 2"],
    ["2-0-1", "hidden layers need 1 to 64 units each"],
    ["2-65-1", /1 to 64 units/],
    ["2-4-4-4-4-4-1", "at most 4 hidden layers"],
  ])("rejects %j", (text, message) => {
    expect(() => parseShape(text)).toThrow(message);
  });
});

describe("validateConfig", () => {
  const bad = (patch: Partial<TrainConfig>) => () => validateConfig({ ...DEFAULT_CONFIG, ...patch } as TrainConfig);

  it("accepts the defaults", () => {
    expect(bad({})).not.toThrow();
  });

  it("names the bad field", () => {
    expect(bad({ dataset: "iris" as never })).toThrow('dataset must be one of moons, circles, xor, spiral; got "iris"');
    expect(bad({ activation: "gelu" as never })).toThrow(/activation must be one of tanh, relu, sigmoid, linear/);
    expect(bad({ loss: "mae" as never })).toThrow(/loss must be one of mse, hinge, bce/);
    expect(bad({ optimizer: "rmsprop" as never })).toThrow(/optimizer must be one of sgd, adam/);
    expect(bad({ shape: [2, 4, 3] })).toThrow(/last size/);
    expect(bad({ l2: -1 })).toThrow("l2 must be 0 or more, got -1");
    expect(bad({ batchSize: -2 })).toThrow("batch size must be a whole number (0 for the full dataset), got -2");
    expect(bad({ batchSize: 1.5 })).toThrow(RangeError);
  });
});

describe("Trainer", () => {
  it("builds the dataset, model and optimizer from the config", () => {
    const t = new Trainer({ dataset: "circles", samples: 60, shape: [2, 8, 1], optimizer: "sgd", lr: 0.05 });
    expect(t.data.X).toHaveLength(60);
    expect(t.data.name).toBe("circles");
    expect(t.model.shape).toEqual([2, 8, 1]);
    expect(t.optimizer).toBeInstanceOf(SGD);
    expect(t.optimizer.lr).toBe(0.05);
    expect(t.config.noise).toBe(0.1);
    expect(new Trainer({ dataset: "spiral" }).config.noise).toBe(0.05);
    expect(new Trainer({ dataset: "spiral", noise: 0.2 }).config.noise).toBe(0.2);
    expect(t.steps).toBe(0);
    expect(t.last).toBeUndefined();
  });

  it("does not share the default shape array", () => {
    const t = new Trainer();
    t.config.shape.push(99);
    expect(DEFAULT_CONFIG.shape).toEqual([2, 16, 16, 1]);
  });

  it("rejects an invalid config", () => {
    expect(() => new Trainer({ dataset: "iris" as never })).toThrow(/dataset must be one of/);
  });

  it("each step lowers the loss on average and records history", () => {
    const t = new Trainer({ dataset: "moons", samples: 80 });
    const first = t.step();
    expect(first.step).toBe(1);
    for (let i = 0; i < 29; i++) t.step();
    expect(t.steps).toBe(30);
    expect(t.history.map((h) => h.step)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(t.last!.loss).toBeLessThan(first.loss);
    expect(t.last!.accuracy).toBe(t.accuracy());
  });

  it("is fully deterministic for a seed", () => {
    const run = () => {
      const t = new Trainer({ dataset: "spiral", samples: 60, batchSize: 16, seed: 3 });
      for (let i = 0; i < 15; i++) t.step();
      return t.history;
    };
    expect(run()).toEqual(run());
  });

  it("samples minibatches without repeats and covers the data", () => {
    const t = new Trainer({ samples: 50, batchSize: 10 });
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const batch = t.nextBatch();
      expect(batch).toHaveLength(10);
      expect(new Set(batch).size).toBe(10);
      batch.forEach((j) => seen.add(j));
    }
    expect(seen.size).toBe(50);
    t.setBatchSize(0);
    expect(t.nextBatch().sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    t.setBatchSize(80);
    expect(t.nextBatch()).toHaveLength(50);
  });

  it("changes hyperparameters live", () => {
    const t = new Trainer({ lr: 0.01 });
    t.setLearningRate(0.1);
    expect(t.optimizer.lr).toBe(0.1);
    expect(t.config.lr).toBe(0.1);
    expect(() => t.setLearningRate(0)).toThrow(RangeError);
    t.setL2(0);
    expect(t.config.l2).toBe(0);
    expect(() => t.setL2(-1)).toThrow(RangeError);
    t.setLoss("bce");
    expect(t.config.loss).toBe("bce");
    expect(() => t.setLoss("nope" as never)).toThrow(RangeError);
    t.setOptimizer("sgd");
    expect(t.optimizer).toBeInstanceOf(SGD);
    expect(t.optimizer.lr).toBe(0.1);
    t.setOptimizer("adam");
    expect(t.optimizer).toBeInstanceOf(Adam);
    expect(() => t.setBatchSize(-1)).toThrow(RangeError);
    t.step();
    expect(t.steps).toBe(1);
  });

  it("every loss and optimizer trains", () => {
    for (const loss of ["mse", "hinge", "bce"] as const) {
      for (const optimizer of ["sgd", "adam"] as const) {
        const t = new Trainer({ dataset: "circles", samples: 60, loss, optimizer, lr: optimizer === "sgd" ? 0.05 : 0.03 });
        const result = train(t, 300, 1);
        expect(result.accuracy, `${loss} + ${optimizer}`).toBeGreaterThanOrEqual(0.95);
      }
    }
  });

  it("predictGrid scores a res × res grid row by row from the top", () => {
    const t = new Trainer({ shape: [2, 4, 1] });
    const grid = t.predictGrid(4, 2);
    expect(grid).toHaveLength(16);
    // Cell centres are at ±0.5 and ±1.5; row 0 is y = 1.5, column 0 is x = -1.5.
    expect(grid[0]).toBe(t.model.predict([-1.5, 1.5])[0]);
    expect(grid[3]).toBe(t.model.predict([1.5, 1.5])[0]);
    expect(grid[15]).toBe(t.model.predict([1.5, -1.5])[0]);
    expect(grid[6]).toBe(t.model.predict([0.5, 0.5])[0]);
  });
});

describe("train", () => {
  it("reaches 100% on XOR within a fixed seeded budget", () => {
    // Noise 0: with jitter a few points can cross an axis into the other class.
    const t = new Trainer({ dataset: "xor", samples: 100, noise: 0, shape: [2, 8, 1], seed: 1 });
    const result = train(t, 500, 1, 20);
    expect(result.accuracy).toBe(1);
    expect(result.reachedAt).not.toBeNull();
    expect(result.reachedAt!).toBeLessThan(200);
    expect(result.steps).toBe(result.reachedAt! + 20);
    expect(t.scores().every((s, i) => Math.sign(s) === t.data.y[i])).toBe(true);
  });

  it("classic 4-point XOR with a 2-4-1 net and plain SGD", () => {
    const t = new Trainer({ dataset: "xor", samples: 4, noise: 0, shape: [2, 4, 1], optimizer: "sgd", lr: 0.1, seed: 2 });
    expect(train(t, 300, 1).accuracy).toBe(1);
  });

  it("stops at the budget when the target is out of reach", () => {
    const t = new Trainer({ dataset: "circles", samples: 40, noise: 1 });
    const result = train(t, 25, 1);
    expect(result.steps).toBe(25);
    expect(result.reachedAt).toBeNull();
    expect(result.accuracy).toBeLessThan(1);
  });

  it("returns the current accuracy when given no steps", () => {
    const t = new Trainer({ samples: 20 });
    const result = train(t, 0);
    expect(result.steps).toBe(0);
    expect(result.accuracy).toBe(t.accuracy());
    expect(result.loss).toBeNaN();
  });

  it("resets the streak when accuracy drops below the target", () => {
    const t = new Trainer({ dataset: "moons", samples: 100, lr: 0.03 });
    const result = train(t, 400, 0.9, 30);
    const tail = t.history.slice(result.reachedAt! - 1);
    expect(tail.every((h) => h.accuracy >= 0.9)).toBe(true);
    expect(t.history[result.reachedAt! - 2]?.accuracy ?? 0).toBeLessThan(0.9);
  });
});
