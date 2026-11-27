import { grayToRGBA, maxOf, toRGBA, viridis } from "./colormap";
import { formatPercent, headline, ranking } from "./format";
import type { Model, Prediction } from "./nn/model";
import type { Tensor } from "./nn/tensor";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id} in index.html`);
  return node as T;
}

function paint(canvas: HTMLCanvasElement, rgba: Uint8ClampedArray): void {
  const img = new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, canvas.width, canvas.height);
  canvas.getContext("2d")!.putImageData(img, 0, 0);
}

/** Everything that draws results: the headline, probability bars, the 28x28 input and the feature maps. */
export class View {
  private readonly headline = el("headline");
  private readonly input28 = el<HTMLCanvasElement>("input28");
  private readonly rows: { li: HTMLLIElement; fill: HTMLElement; pct: HTMLElement }[] = [];
  private readonly mapGrids: { grid: HTMLElement; canvases: HTMLCanvasElement[]; shape: number[] }[] = [];

  constructor(model: Model) {
    const bars = el("bars");
    for (let d = 0; d < model.classes; d++) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="digit">${d}</span><span class="track"><span class="fill"></span></span><span class="pct">0%</span>`;
      bars.append(li);
      this.rows.push({ li, fill: li.querySelector(".fill")!, pct: li.querySelector(".pct")! });
    }
    // One grid of canvases per conv layer, sized from the model's own shapes.
    const convShapes = model.spec.layers
      .map((l, i) => ({ l, shape: model.shapes[i] }))
      .filter((x) => x.l.type === "conv2d")
      .map((x) => x.shape);
    convShapes.slice(0, 2).forEach((shape, i) => {
      const grid = el(`maps${i + 1}`);
      el(`maps${i + 1}-title`).textContent = `Layer ${i + 1}: ${shape[0]} filters, ${shape[1]}×${shape[2]} maps`;
      const canvases = Array.from({ length: shape[0] }, () => {
        const c = document.createElement("canvas");
        c.width = shape[2];
        c.height = shape[1];
        grid.append(c);
        return c;
      });
      this.mapGrids.push({ grid, canvases, shape });
    });
    this.showEmpty();
  }

  /** Nothing drawn: clear the readout instead of showing what the network makes of a blank page. */
  showEmpty(): void {
    this.headline.className = "headline small";
    this.headline.textContent = headline(0, 0, true);
    for (const r of this.rows) {
      r.li.classList.remove("top");
      r.fill.style.width = "0%";
      r.pct.textContent = "0%";
    }
    paint(this.input28, grayToRGBA(new Float32Array(this.input28.width * this.input28.height)));
    for (const { grid, canvases } of this.mapGrids) {
      grid.classList.add("idle");
      const dark = viridis(0);
      for (const c of canvases) {
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = `rgb(${dark[0]},${dark[1]},${dark[2]})`;
        ctx.fillRect(0, 0, c.width, c.height);
      }
    }
  }

  show(pred: Prediction, input: Float32Array, model: Model): void {
    const small = pred.confidence < 0.5;
    this.headline.className = small ? "headline small" : "headline";
    this.headline.innerHTML = small
      ? headline(pred.label, pred.confidence, false)
      : `${headline(pred.label, pred.confidence, false)}<span class="conf">${formatPercent(pred.confidence)}</span>`;
    const order = ranking(pred.probs);
    this.rows.forEach((r, d) => {
      r.li.classList.toggle("top", d === order[0]);
      r.fill.style.width = `${(pred.probs[d] * 100).toFixed(2)}%`;
      r.pct.textContent = formatPercent(pred.probs[d]);
    });
    paint(this.input28, grayToRGBA(input));

    const maps = model.convMaps(pred.activations);
    this.mapGrids.forEach((g, i) => this.drawMaps(g, maps[i]));
  }

  private drawMaps(g: { grid: HTMLElement; canvases: HTMLCanvasElement[] }, t: Tensor): void {
    g.grid.classList.remove("idle");
    const [, h, w] = t.shape;
    const scale = maxOf(t.data); // one scale per layer, so strong and weak filters stay comparable
    g.canvases.forEach((c, k) => paint(c, toRGBA(t.data, k * h * w, h * w, scale)));
  }
}
