/**
 * Trains the default network on every dataset and prints a results table.
 *
 *   npm run train:all                      # defaults: 2-16-16-1 tanh, hinge, Adam 0.03
 *   npm run train:all -- --steps 3000      # change the step budget
 *   npm run train:all -- --noise 0.1       # same noise for every dataset
 *
 * Each run stops once accuracy has stayed at 100% for 50 steps, or at the budget.
 */
import { DATASETS } from "../src/datasets";
import { Trainer, train, type TrainConfig } from "../src/train";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const maxSteps = Number(flag("steps") ?? 3000);
const overrides: Partial<TrainConfig> = {};
if (flag("noise") !== undefined) overrides.noise = Number(flag("noise"));
if (flag("seed") !== undefined) overrides.seed = Number(flag("seed"));
if (flag("activation") !== undefined) overrides.activation = flag("activation") as TrainConfig["activation"];
if (flag("loss") !== undefined) overrides.loss = flag("loss") as TrainConfig["loss"];
if (flag("optimizer") !== undefined) overrides.optimizer = flag("optimizer") as TrainConfig["optimizer"];
if (flag("lr") !== undefined) overrides.lr = Number(flag("lr"));

const first = new Trainer(overrides).config;
console.log(
  `MLP ${first.shape.join("-")} ${first.activation}, ${first.loss} loss, ${first.optimizer} lr=${first.lr}, ` +
    `l2=${first.l2}, ${first.samples} samples, full batch, seed ${first.seed}, budget ${maxSteps} steps\n`,
);
console.log("| Dataset | Noise | Steps to 100% | Final accuracy | Final loss | Steps run | Time |");
console.log("|---------|------:|--------------:|---------------:|-----------:|----------:|-----:|");

for (const dataset of DATASETS) {
  const trainer = new Trainer({ ...overrides, dataset });
  const start = performance.now();
  const result = train(trainer, maxSteps, 1, 50);
  const seconds = (performance.now() - start) / 1000;
  const reached = result.reachedAt ?? "not reached";
  console.log(
    `| ${dataset} | ${trainer.config.noise} | ${reached} | ${(result.accuracy * 100).toFixed(1)}% | ` +
      `${result.loss.toFixed(4)} | ${result.steps} | ${seconds.toFixed(1)}s |`,
  );
}
