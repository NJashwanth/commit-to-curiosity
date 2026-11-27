import "./style.css";
import { DrawingPad } from "./canvas-pad";
import { fetchModel } from "./nn/model";
import { preprocess } from "./preprocess";
import { View } from "./view";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  const model = await fetchModel(`${import.meta.env.BASE_URL}model.json`);
  const view = new View(model);
  const pad = new DrawingPad($("pad") as HTMLCanvasElement, Number(($("brush") as HTMLInputElement).value));
  const hint = $("pad-hint");

  // Predict at most once per frame, however many pointer events arrive.
  let queued = false;
  const update = () => {
    queued = false;
    const { pixels, width, height } = pad.snapshot();
    const pre = preprocess(pixels, width, height);
    hint.classList.toggle("hidden", !pre.empty);
    if (pre.empty) return view.showEmpty();
    view.show(model.predict(pre.pixels), pre.pixels, model);
  };
  pad.onChange = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  };

  const brush = $("brush") as HTMLInputElement;
  brush.addEventListener("input", () => {
    pad.setBrush(Number(brush.value));
    $("brush-value").textContent = brush.value;
  });
  $("clear").addEventListener("click", () => pad.clear());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "c" && !e.metaKey && !e.ctrlKey && document.activeElement?.tagName !== "INPUT")) pad.clear();
  });

  const meta = model.spec.meta as { dataset?: string; test_accuracy?: number; val_accuracy?: number; params?: number };
  const acc = meta.test_accuracy !== undefined ? ` Accuracy on its ${meta.dataset === "mnist" ? "MNIST test set" : "test set"}: ${(meta.test_accuracy * 100).toFixed(2)}%.` : "";
  $("model-info").textContent = `Model: ${meta.params?.toLocaleString() ?? "?"} parameters, trained on ${meta.dataset ?? "unknown data"}.${acc} Everything runs in your browser; nothing you draw leaves it.`;
  update();
}

main().catch((err) => {
  const h = $("headline");
  h.className = "headline small";
  h.textContent = `Could not load the model: ${err instanceof Error ? err.message : err}`;
});
