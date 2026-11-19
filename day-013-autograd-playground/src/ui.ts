/**
 * Browser glue: the training playground (controls, heatmap, charts) and the
 * graph viewer panel. All the maths lives in the core modules.
 */
import { DEFAULT_NOISE, type DatasetName } from "./datasets";
import { build, parse, renderSvg, variables, type Expr } from "./graphview";
import type { Activation, LossName } from "./nn";
import type { OptimizerName } from "./optim";
import { Trainer, parseShape, type StepStats, type TrainConfig } from "./train";

/** The heatmap shows [-EXTENT, EXTENT]² in data units. */
const EXTENT = 1.3;
/** Heatmap cells per side; the canvas smooths them when scaling up. */
const GRID = 72;
/** Milliseconds of training per animation frame. */
const FRAME_BUDGET = 14;
const CHART_POINTS = 300;

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function startApp(): void {
  setupTabs();
  new Playground();
  new GraphViewer();
}

// ------------------------------------------------------------------ tabs ----

function setupTabs(): void {
  const tabs = [
    { button: byId<HTMLButtonElement>("tab-btn-train"), panel: byId("tab-train"), hash: "" },
    { button: byId<HTMLButtonElement>("tab-btn-graph"), panel: byId("tab-graph"), hash: "#graph" },
  ];
  const show = (hash: string) => {
    for (const t of tabs) {
      const on = t.hash === (hash === "#graph" ? "#graph" : "");
      t.button.setAttribute("aria-selected", String(on));
      t.panel.hidden = !on;
    }
  };
  for (const t of tabs) {
    t.button.addEventListener("click", () => {
      history.replaceState(null, "", t.hash || location.pathname + location.search);
      show(t.hash);
    });
  }
  window.addEventListener("hashchange", () => show(location.hash));
  show(location.hash);
}

// ------------------------------------------------------------ playground ----

type Rgb = [number, number, number];

function cssColor(name: string): Rgb {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(name).trim().replace("#", "");
  const n = parseInt(hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

class Playground {
  private trainer!: Trainer;
  private playing = false;
  private frame = 0;
  private stepTimes: number[] = [];
  private stepsPerSecond = 0;
  private colors!: { pos: Rgb; neg: Rgb; mid: Rgb; stroke: string; ink: string };

  private readonly el = {
    dataset: byId<HTMLSelectElement>("dataset"),
    samples: byId<HTMLInputElement>("samples"),
    samplesOut: byId<HTMLOutputElement>("samples-out"),
    noise: byId<HTMLInputElement>("noise"),
    noiseOut: byId<HTMLOutputElement>("noise-out"),
    seed: byId<HTMLInputElement>("seed"),
    shape: byId<HTMLInputElement>("shape"),
    shapeMsg: byId("shape-msg"),
    activation: byId<HTMLSelectElement>("activation"),
    loss: byId<HTMLSelectElement>("loss"),
    optimizer: byId<HTMLSelectElement>("optimizer"),
    lr: byId<HTMLSelectElement>("lr"),
    l2: byId<HTMLSelectElement>("l2"),
    batch: byId<HTMLSelectElement>("batch"),
    play: byId<HTMLButtonElement>("play"),
    step: byId<HTMLButtonElement>("step"),
    reset: byId<HTMLButtonElement>("reset"),
    canvas: byId<HTMLCanvasElement>("heatmap"),
    error: byId("train-error"),
    statStep: byId("stat-step"),
    statSps: byId("stat-sps"),
    statLoss: byId("stat-loss"),
    statAcc: byId("stat-acc"),
    lossChart: byId<SVGSVGElement & HTMLElement>("loss-chart"),
    accChart: byId<SVGSVGElement & HTMLElement>("acc-chart"),
  };
  private readonly offscreen = document.createElement("canvas");

  constructor() {
    this.offscreen.width = GRID;
    this.offscreen.height = GRID;
    this.readColors();
    this.bindControls();
    this.reset();
    new ResizeObserver(() => this.drawHeatmap()).observe(this.el.canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.readColors();
      this.render();
    });
  }

  private readColors(): void {
    const style = getComputedStyle(document.documentElement);
    this.colors = {
      pos: cssColor("--pos"),
      neg: cssColor("--neg"),
      mid: cssColor("--heat-mid"),
      stroke: style.getPropertyValue("--point-stroke").trim(),
      ink: style.getPropertyValue("--ink").trim(),
    };
  }

  private config(): TrainConfig {
    const e = this.el;
    return {
      dataset: e.dataset.value as DatasetName,
      samples: Number(e.samples.value),
      noise: Number(e.noise.value),
      seed: Math.trunc(Number(e.seed.value) || 0),
      shape: parseShape(e.shape.value),
      activation: e.activation.value as Activation,
      loss: e.loss.value as LossName,
      optimizer: e.optimizer.value as OptimizerName,
      lr: Number(e.lr.value),
      l2: Number(e.l2.value),
      batchSize: Number(e.batch.value),
    };
  }

  private bindControls(): void {
    const e = this.el;
    const live = (el: HTMLElement, apply: () => void) =>
      el.addEventListener("change", () => this.guard(apply));

    e.dataset.addEventListener("change", () => {
      e.noise.value = String(DEFAULT_NOISE[e.dataset.value as DatasetName]);
      this.reset();
    });
    for (const input of [e.samples, e.noise]) input.addEventListener("input", () => this.reset());
    e.seed.addEventListener("change", () => this.reset());
    e.activation.addEventListener("change", () => this.reset());
    e.shape.addEventListener("input", () => {
      if (this.checkShape()) this.reset();
    });

    live(e.loss, () => this.trainer.setLoss(e.loss.value as LossName));
    live(e.optimizer, () => this.trainer.setOptimizer(e.optimizer.value as OptimizerName));
    live(e.lr, () => this.trainer.setLearningRate(Number(e.lr.value)));
    live(e.l2, () => this.trainer.setL2(Number(e.l2.value)));
    live(e.batch, () => this.trainer.setBatchSize(Number(e.batch.value)));

    e.play.addEventListener("click", () => this.toggle());
    e.step.addEventListener("click", () => this.stepOnce());
    e.reset.addEventListener("click", () => this.reset());
    byId("controls").addEventListener("submit", (ev) => ev.preventDefault());

    document.addEventListener("keydown", (ev) => {
      const target = ev.target as HTMLElement;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || byId("tab-train").hidden) return;
      if (target.closest("input, select, textarea")) return;
      if (ev.key === " " && !target.closest("button")) {
        ev.preventDefault();
        this.toggle();
      } else if (ev.key === "s" || ev.key === "S") this.stepOnce();
      else if (ev.key === "r" || ev.key === "R") this.reset();
    });
  }

  /** Validates the shape box, showing why it's wrong. Returns true if valid. */
  private checkShape(): boolean {
    const { shape, shapeMsg } = this.el;
    try {
      const sizes = parseShape(shape.value);
      shape.removeAttribute("aria-invalid");
      shapeMsg.classList.remove("bad");
      let params = 0;
      for (let i = 1; i < sizes.length; i++) params += (sizes[i - 1]! + 1) * sizes[i]!;
      shapeMsg.innerHTML = `input-hidden…-output · <span id="param-count">${params}</span> params`;
      return true;
    } catch (err) {
      shape.setAttribute("aria-invalid", "true");
      shapeMsg.classList.add("bad");
      shapeMsg.textContent = message(err);
      return false;
    }
  }

  private guard(fn: () => void): void {
    try {
      fn();
      this.showError(null);
    } catch (err) {
      this.showError(message(err));
    }
  }

  private showError(text: string | null): void {
    this.el.error.hidden = text === null;
    this.el.error.textContent = text ?? "";
  }

  reset(): void {
    this.el.samplesOut.textContent = this.el.samples.value;
    this.el.noiseOut.textContent = Number(this.el.noise.value).toFixed(2);
    if (!this.checkShape()) return;
    try {
      this.trainer = new Trainer(this.config());
      this.showError(null);
    } catch (err) {
      this.showError(message(err));
      this.pause();
      return;
    }
    this.stepTimes = [];
    this.stepsPerSecond = 0;
    this.render();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.el.play.textContent = "Pause";
    this.el.step.disabled = true;
    this.frame = requestAnimationFrame(() => this.tick());
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.el.play.textContent = "Play";
    this.el.step.disabled = false;
  }

  stepOnce(): void {
    if (this.playing) return;
    this.trainStep();
    this.render();
  }

  private tick(): void {
    const start = performance.now();
    do {
      if (!this.trainStep()) break;
    } while (performance.now() - start < FRAME_BUDGET);
    this.render();
    if (this.playing) this.frame = requestAnimationFrame(() => this.tick());
  }

  /** One training step; on an error (usually divergence) stop and explain. */
  private trainStep(): StepStats | null {
    try {
      const stats = this.trainer.step();
      const now = performance.now();
      this.stepTimes.push(now);
      while (this.stepTimes[0]! < now - 1000) this.stepTimes.shift();
      const span = Math.max(now - this.stepTimes[0]!, 1);
      if (this.stepTimes.length > 1) this.stepsPerSecond = ((this.stepTimes.length - 1) * 1000) / span;
      return stats;
    } catch (err) {
      this.pause();
      this.showError(`Training stopped at step ${this.trainer.steps + 1}: ${message(err)}. Try a lower learning rate, then Reset.`);
      return null;
    }
  }

  private render(): void {
    this.drawHeatmap();
    const last = this.trainer.last;
    const e = this.el;
    e.statStep.textContent = String(this.trainer.steps);
    e.statSps.textContent = this.stepsPerSecond ? this.stepsPerSecond.toFixed(0) : "0";
    e.statLoss.textContent = last ? last.loss.toFixed(4) : "–";
    e.statAcc.textContent = `${((last?.accuracy ?? this.trainer.accuracy()) * 100).toFixed(1)}%`;
    renderChart(e.lossChart, this.trainer.history, "loss");
    renderChart(e.accChart, this.trainer.history, "acc");
  }

  private drawHeatmap(): void {
    if (!this.trainer) return;
    const canvas = this.el.canvas;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(canvas.clientWidth * dpr);
    if (size === 0) return;
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const { pos, neg, mid, stroke, ink } = this.colors;

    // 1. Score every grid cell and colour it: the further from 0, the stronger.
    const scores = this.trainer.predictGrid(GRID, EXTENT);
    const octx = this.offscreen.getContext("2d")!;
    const img = octx.createImageData(GRID, GRID);
    for (let i = 0; i < scores.length; i++) {
      const t = Math.tanh(scores[i]!);
      const target = t > 0 ? pos : neg;
      const k = Math.min(1, Math.abs(t)) * 0.62;
      img.data[i * 4] = mid[0] + (target[0] - mid[0]) * k;
      img.data[i * 4 + 1] = mid[1] + (target[1] - mid[1]) * k;
      img.data[i * 4 + 2] = mid[2] + (target[2] - mid[2]) * k;
      img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.offscreen, 0, 0, size, size);

    // 2. Axes through the origin.
    const toPx = (v: number) => ((v + EXTENT) / (2 * EXTENT)) * size;
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(toPx(0), 0);
    ctx.lineTo(toPx(0), size);
    ctx.moveTo(0, toPx(0));
    ctx.lineTo(size, toPx(0));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 3. The data, with a ring around anything the network gets wrong.
    const { X, y } = this.trainer.data;
    const predicted = this.trainer.scores();
    const r = Math.max(3, size / 110);
    for (let i = 0; i < X.length; i++) {
      const px = toPx(X[i]![0]!);
      const py = size - toPx(X[i]![1]!);
      const [cr, cg, cb] = y[i] === 1 ? pos : neg;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 2 * Math.PI);
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fill();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = stroke;
      ctx.stroke();
      if ((predicted[i]! > 0 ? 1 : -1) !== y[i]) {
        ctx.beginPath();
        ctx.arc(px, py, r + 3 * dpr, 0, 2 * Math.PI);
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = ink;
        ctx.stroke();
      }
    }
  }
}

// ---------------------------------------------------------------- charts ----

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART = { w: 320, h: 130, left: 40, right: 10, top: 8, bottom: 20 };

function svgEl(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Keeps at most `n` points, always including the last one. */
function downsample<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return xs.slice();
  const stride = xs.length / n;
  const out: T[] = [];
  for (let i = 0; i < n - 1; i++) out.push(xs[Math.floor(i * stride)]!);
  out.push(xs[xs.length - 1]!);
  return out;
}

const decimal = (k: number) => (k >= 0 ? String(10 ** k) : (10 ** k).toFixed(-k));

function renderChart(svg: SVGSVGElement, history: readonly StepStats[], kind: "loss" | "acc"): void {
  svg.replaceChildren();
  const { w, h, left, right, top, bottom } = CHART;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  if (history.length === 0) {
    svg.append(svgEl("rect", { class: "grid", x: left, y: top, width: plotW, height: plotH, fill: "none" }));
    svg.append(svgEl("text", { class: "empty", x: left + plotW / 2, y: top + plotH / 2 + 4, "text-anchor": "middle" }, "Press Play or Step to train"));
    return;
  }

  const pts = downsample(history, CHART_POINTS);
  const lastStep = history[history.length - 1]!.step;
  const x = (step: number) => left + (lastStep <= 1 ? plotW : ((step - 1) / (lastStep - 1)) * plotW);

  let y: (s: StepStats) => number;
  const ticks: { at: number; label: string }[] = [];
  if (kind === "loss") {
    const logs = pts.map((p) => Math.log10(Math.max(p.loss, 1e-4)));
    let lo = Math.floor(Math.min(...logs));
    let hi = Math.ceil(Math.max(...logs));
    if (hi === lo) hi = lo + 1;
    if (hi - lo > 4) lo = hi - 4;
    y = (s) => top + ((hi - Math.max(Math.log10(Math.max(s.loss, 1e-4)), lo)) / (hi - lo)) * plotH;
    for (let k = lo; k <= hi; k++) ticks.push({ at: top + ((hi - k) / (hi - lo)) * plotH, label: decimal(k) });
  } else {
    y = (s) => top + (1 - s.accuracy) * plotH;
    for (const a of [0, 0.5, 1]) ticks.push({ at: top + (1 - a) * plotH, label: `${a * 100}%` });
  }

  for (const t of ticks) {
    svg.append(svgEl("line", { class: "grid", x1: left, x2: left + plotW, y1: t.at, y2: t.at }));
    svg.append(svgEl("text", { class: "axis-label", x: left - 6, y: t.at + 3, "text-anchor": "end" }, t.label));
  }
  svg.append(svgEl("text", { class: "axis-label", x: left, y: h - 4 }, "1"));
  svg.append(svgEl("text", { class: "axis-label", x: left + plotW, y: h - 4, "text-anchor": "end" }, `step ${lastStep}`));

  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.step).toFixed(1)},${y(p).toFixed(1)}`).join("");
  if (kind === "acc") {
    const area = `${line}L${x(lastStep).toFixed(1)},${top + plotH}L${x(pts[0]!.step).toFixed(1)},${top + plotH}Z`;
    svg.append(svgEl("path", { class: "area acc", d: area }));
  }
  svg.append(svgEl("path", { class: `series ${kind}`, d: line }));
}

// ----------------------------------------------------------- graph viewer ---

const DEFAULT_VALUES: Record<string, number> = {
  a: 2,
  b: -0.5,
  c: 0.25,
  w1: 0.5,
  x1: 1,
  w2: -1,
  x2: 2,
};

class GraphViewer {
  private readonly values: Record<string, number> = { ...DEFAULT_VALUES };
  private expr: Expr | null = null;
  private readonly el = {
    form: byId<HTMLFormElement>("graph-form"),
    expr: byId<HTMLInputElement>("expr"),
    vars: byId("vars"),
    error: byId("graph-error"),
    out: byId("graph-out"),
    status: byId("graph-status"),
  };

  constructor() {
    const e = this.el;
    e.expr.addEventListener("input", () => this.parseExpression());
    e.form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.draw(true);
    });
    for (const chip of document.querySelectorAll<HTMLButtonElement>(".chip")) {
      chip.addEventListener("click", () => {
        e.expr.value = chip.textContent ?? "";
        this.parseExpression();
      });
    }
    this.parseExpression();
  }

  private parseExpression(): void {
    try {
      this.expr = parse(this.el.expr.value);
      this.el.expr.removeAttribute("aria-invalid");
    } catch (err) {
      this.expr = null;
      this.el.expr.setAttribute("aria-invalid", "true");
      this.showError(message(err));
      return;
    }
    this.syncInputs(variables(this.expr));
    this.draw(false);
  }

  /** One number box per variable, keeping values the user already typed. */
  private syncInputs(names: string[]): void {
    const current = new Map([...this.el.vars.querySelectorAll<HTMLInputElement>("input")].map((i) => [i.name, i]));
    const labels: HTMLElement[] = names.map((name) => {
      const existing = current.get(name);
      if (existing) return existing.parentElement!;
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.name = name;
      input.value = String(this.values[name] ?? 1);
      this.values[name] ??= 1;
      input.addEventListener("input", () => {
        const v = input.valueAsNumber;
        if (Number.isFinite(v)) {
          this.values[name] = v;
          input.removeAttribute("aria-invalid");
          this.draw(false);
        } else input.setAttribute("aria-invalid", "true");
      });
      label.append(name, input);
      return label;
    });
    this.el.vars.replaceChildren(...labels);
  }

  /** Builds the graph; runs backward only when asked, so grads start at 0. */
  private draw(withBackward: boolean): void {
    if (!this.expr) return;
    try {
      const { output } = build(this.expr, this.values);
      if (withBackward) output.backward();
      this.el.out.innerHTML = renderSvg(output);
      this.el.status.textContent = withBackward
        ? `output = ${output.data.toPrecision(6)}. Backward set its grad to 1 and pushed it back through every node.`
        : `output = ${output.data.toPrecision(6)}. Grads are 0 until you press Run backward.`;
      this.showError(null);
    } catch (err) {
      this.showError(message(err));
    }
  }

  private showError(text: string | null): void {
    this.el.error.hidden = text === null;
    this.el.error.textContent = text ?? "";
    if (text !== null) this.el.status.textContent = "";
  }
}
