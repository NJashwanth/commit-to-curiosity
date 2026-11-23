import { renderChart } from "./chart";
import { Evolution, defaultEvolution, type CrossoverKind, type GenerationStats } from "./ga";
import { genomeColorCss, vertexPoints } from "./genome";
import { GenomeImportError, HallOfFame, exportGenome, exportHof, importHof, type HofEntry } from "./hof";
import { SPAWN_X } from "./physics";
import { Simulation, type Entry } from "./sim";
import { difficultyAt, generateTerrain, type Terrain } from "./terrain";

// Browser glue: canvas rendering, camera, stats, controls and the chart.
// All evolution logic lives in the core modules; this file only draws and wires.

type Speed = 1 | 4 | 16 | "skip";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface App {
  evo: Evolution;
  hof: HallOfFame;
  sim: Simulation;
  speed: Speed;
  paused: boolean;
  /** Called after every finished generation, before the next one is bred. */
  onGeneration: Array<(stats: GenerationStats, evo: Evolution) => void>;
  /** When set, the stage shows this simulation instead of the live generation. */
  replay: Simulation | null;
  replayEntry(entry: HofEntry): void;
  setSpeed(s: Speed): void;
  startGeneration(): void;
  reset(seed?: number): void;
  step(): void;
  render(): void;
}

const MAX_STEPS_PER_FRAME = 96;

function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function paramSeed(): number | null {
  const v = new URLSearchParams(location.search).get("seed");
  return v !== null && Number.isFinite(Number(v)) ? Number(v) : null;
}

export function createApp(): App {
  const canvas = $<HTMLCanvasElement>("stage");
  const ctx = canvas.getContext("2d")!;
  const seed = paramSeed() ?? randomSeed();
  const camera = { x: SPAWN_X, y: 0 };
  let evo = new Evolution(defaultEvolution(seed));
  let sim = new Simulation(evo.terrain, evo.genomes, evo.cfg.sim);
  const hof = new HallOfFame();

  const app: App = {
    evo,
    hof,
    sim,
    speed: 1,
    paused: false,
    onGeneration: [],
    replay: null,
    replayEntry(entry) {
      app.replay = new Simulation(generateTerrain(entry.terrainSeed), [entry.genome], evo.cfg.sim);
      camera.x = SPAWN_X;
      $("h-msg").textContent = `Replaying generation ${entry.generation} (${entry.distance.toFixed(1)} m, terrain ${entry.terrainSeed}).`;
    },
    setSpeed(s) {
      app.speed = s;
      for (const b of document.querySelectorAll<HTMLButtonElement>("#speed-row button")) {
        b.classList.toggle("on", b.dataset.speed === String(s));
      }
    },
    startGeneration() {
      app.sim = sim = new Simulation(evo.terrain, evo.genomes, evo.cfg.sim);
    },
    reset(newSeed = randomSeed()) {
      const keepGa = { ...evo.cfg.ga };
      const cfg = defaultEvolution(newSeed);
      cfg.ga = keepGa;
      app.evo = evo = new Evolution(cfg);
      app.startGeneration();
      app.replay = null;
      hof.clear();
      renderHof();
      camera.x = SPAWN_X;
      drawChart();
      updateSeeds();
    },
    step() {
      const active = app.replay ?? sim;
      active.step();
      if (app.replay) return;
      if (sim.done) finishGeneration();
    },
    render() {
      draw();
    },
  };

  function finishGeneration(): void {
    const stats = evo.record(sim.fitness());
    hof.add(stats, evo.cfg.terrainSeed);
    renderHof();
    for (const fn of app.onGeneration) fn(stats, evo);
    evo.advance();
    app.startGeneration();
    drawChart();
  }

  // ---- rendering -------------------------------------------------------

  function fitCanvas(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(320, Math.round(rect.width * dpr));
    const h = Math.max(200, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function draw(): void {
    fitCanvas();
    const active = app.replay ?? sim;
    const W = canvas.width;
    const H = canvas.height;
    const scale = W / 32;
    const lead = active.entries[active.leaderIndex()];
    const lp = lead.car.chassis.getPosition();
    camera.x += (lp.x - camera.x) * 0.12;
    camera.y += (lp.y - camera.y) * 0.08;
    const sx = (x: number) => W * 0.4 + (x - camera.x) * scale;
    const sy = (y: number) => H * 0.62 - (y - camera.y) * scale;

    ctx.clearRect(0, 0, W, H);
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#0e1522");
    sky.addColorStop(1, "#16213a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    drawTerrain(active.terrain, sx, sy, scale, W, H);

    // Dead cars first so live ones paint on top.
    const order = [...active.entries].sort((a, b) => Number(a.life.alive) - Number(b.life.alive));
    for (const e of order) drawCar(e, e === lead, sx, sy, scale);

    ctx.fillStyle = "#e6ebf5";
    ctx.font = `${Math.round(12 * (W / 960))}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(`leader ${lead.life.distance.toFixed(1)} m`, 12, 20 * (W / 960));
    if (app.replay) ctx.fillText("REPLAY", 12, 38 * (W / 960));
  }

  function drawTerrain(t: Terrain, sx: (x: number) => number, sy: (y: number) => number, scale: number, W: number, H: number): void {
    const x0 = camera.x - (W * 0.4) / scale - 2;
    const x1 = camera.x + (W * 0.6) / scale + 2;
    const i0 = Math.max(0, Math.floor(x0));
    const i1 = Math.min(t.points.length - 1, Math.ceil(x1));
    if (i1 <= i0) return;
    const d = difficultyAt((x0 + x1) / 2);
    ctx.beginPath();
    ctx.moveTo(sx(t.points[i0].x), H + 10);
    for (let i = i0; i <= i1; i++) ctx.lineTo(sx(t.points[i].x), sy(t.points[i].y));
    ctx.lineTo(sx(t.points[i1].x), H + 10);
    ctx.closePath();
    ctx.fillStyle = `hsl(${140 - 130 * d}, 35%, 18%)`;
    ctx.fill();
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const px = sx(t.points[i].x);
      const py = sy(t.points[i].y);
      if (i === i0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = `hsl(${140 - 130 * d}, 60%, 55%)`;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Distance markers every 25 m.
    ctx.fillStyle = "#8b97ad";
    ctx.font = `${Math.round(10 * (W / 960))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    for (let m = Math.ceil((x0 - SPAWN_X) / 25) * 25; m <= x1 - SPAWN_X; m += 25) {
      if (m < 0) continue;
      const px = sx(SPAWN_X + m);
      const idx = Math.min(t.points.length - 1, Math.round(SPAWN_X + m));
      ctx.fillText(`${m}m`, px, sy(t.points[idx].y) + 16 * (W / 960));
    }
  }

  function drawCar(e: Entry, isLeader: boolean, sx: (x: number) => number, sy: (y: number) => number, scale: number): void {
    const { car, life } = e;
    const p = car.chassis.getPosition();
    const a = car.chassis.getAngle();
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const alpha = life.alive ? 0.85 : 0.18;
    const pts = vertexPoints(car.genome);
    ctx.beginPath();
    pts.forEach((v, i) => {
      const wx = p.x + v.x * cos - v.y * sin;
      const wy = p.y + v.x * sin + v.y * cos;
      if (i === 0) ctx.moveTo(sx(wx), sy(wy));
      else ctx.lineTo(sx(wx), sy(wy));
    });
    ctx.closePath();
    ctx.fillStyle = genomeColorCss(car.genome, alpha);
    ctx.fill();
    ctx.lineWidth = isLeader ? 2.5 : 1;
    ctx.strokeStyle = isLeader ? "#ffffff" : `rgba(255,255,255,${life.alive ? 0.45 : 0.1})`;
    ctx.stroke();

    car.wheels.forEach((w, k) => {
      const wp = w.getPosition();
      const r = car.genome.wheels[k].radius * scale;
      const wa = w.getAngle();
      ctx.beginPath();
      ctx.arc(sx(wp.x), sy(wp.y), r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(20,24,34,${alpha})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(230,235,245,${life.alive ? 0.8 : 0.15})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx(wp.x), sy(wp.y));
      ctx.lineTo(sx(wp.x) + Math.cos(-wa) * r, sy(wp.y) + Math.sin(-wa) * r);
      ctx.stroke();
    });
  }

  // ---- stats and chart -------------------------------------------------

  function drawChart(): void {
    $("chart").innerHTML = renderChart(evo.history);
  }

  function updateStats(): void {
    const active = app.replay ?? sim;
    const fit = active.fitness();
    const best = Math.max(0, ...fit);
    const avg = fit.reduce((a, b) => a + b, 0) / fit.length;
    $("s-gen").textContent = app.replay ? "replay" : String(evo.generation);
    $("s-alive").textContent = `${active.aliveCount}/${active.entries.length}`;
    $("s-time").textContent = `${active.time.toFixed(0)}s`;
    $("s-best").textContent = best.toFixed(1);
    $("s-avg").textContent = avg.toFixed(1);
    $("s-lead").textContent = active.entries[active.leaderIndex()].life.distance.toFixed(1);
  }

  function updateSeeds(): void {
    $("seeds").textContent = `evolution seed ${evo.cfg.seed}, terrain seed ${evo.cfg.terrainSeed}. Add ?seed=42 to the URL to repeat a run.`;
  }

  // ---- hall of fame ----------------------------------------------------

  function download(name: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function renderHof(): void {
    const best = hof.best();
    $("h-count").textContent = `(${hof.entries.length})`;
    const list = $("h-list");
    list.textContent = "";
    hof.entries.forEach((entry, i) => {
      const row = document.createElement("div");
      row.className = "hof-row" + (entry === best ? " top" : "");
      const swatch = document.createElement("i");
      swatch.style.background = genomeColorCss(entry.genome);
      const gen = document.createElement("span");
      gen.textContent = `gen ${entry.generation}`;
      const dist = document.createElement("b");
      dist.textContent = `${entry.distance.toFixed(1)} m`;
      const play = document.createElement("button");
      play.textContent = "Replay";
      play.addEventListener("click", () => app.replayEntry(entry));
      const save = document.createElement("button");
      save.textContent = "Export";
      save.addEventListener("click", () => download(`car-gen-${entry.generation}-${i}.json`, exportGenome(entry.genome, entry)));
      row.append(swatch, gen, dist, play, save);
      list.append(row);
    });
    list.scrollTop = list.scrollHeight;
  }

  $("h-export").addEventListener("click", () => download("hall-of-fame.json", exportHof(hof)));
  $("h-export-best").addEventListener("click", () => {
    const best = hof.best();
    if (best) download("best-car.json", exportGenome(best.genome, best));
    else $("h-msg").textContent = "Nothing to export yet. Finish a generation first.";
  });
  $("h-import-btn").addEventListener("click", () => $("h-import").click());
  $<HTMLInputElement>("h-import").addEventListener("change", async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const entries = importHof(await file.text());
      hof.entries.push(...entries);
      renderHof();
      $("h-msg").textContent = `Imported ${entries.length} car${entries.length === 1 ? "" : "s"} from ${file.name}.`;
    } catch (e) {
      $("h-msg").textContent = e instanceof GenomeImportError ? e.message : `Could not read ${file.name}.`;
    }
    input.value = "";
  });
  $("h-live").addEventListener("click", () => {
    app.replay = null;
    camera.x = app.sim.entries[app.sim.leaderIndex()].car.chassis.getPosition().x;
    $("h-msg").textContent = "";
  });

  // ---- controls --------------------------------------------------------

  function bindRange(id: string, out: string, digits: number, apply: (v: number) => void): void {
    const input = $<HTMLInputElement>(id);
    const update = () => {
      const v = Number(input.value);
      $(out).textContent = v.toFixed(digits);
      apply(v);
    };
    input.addEventListener("input", update);
    update();
  }

  bindRange("c-pop", "o-pop", 0, (v) => (evo.cfg.ga.populationSize = v));
  bindRange("c-rate", "o-rate", 2, (v) => (evo.cfg.ga.mutationRate = v));
  bindRange("c-strength", "o-strength", 2, (v) => (evo.cfg.ga.mutationStrength = v));
  $<HTMLSelectElement>("c-cross").addEventListener("change", (ev) => {
    evo.cfg.ga.crossover = (ev.target as HTMLSelectElement).value as CrossoverKind;
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>("#speed-row button")) {
    b.addEventListener("click", () => {
      const s = b.dataset.speed!;
      app.setSpeed(s === "skip" ? "skip" : (Number(s) as Speed));
    });
  }
  $("b-pause").addEventListener("click", () => {
    app.paused = !app.paused;
    $("b-pause").textContent = app.paused ? "Resume" : "Pause";
  });
  $("b-terrain").addEventListener("click", () => {
    evo.setTerrainSeed(randomSeed());
    evo.history = [];
    evo.generation = 1;
    app.replay = null;
    app.startGeneration();
    camera.x = SPAWN_X;
    drawChart();
    updateSeeds();
  });
  $("b-reset").addEventListener("click", () => app.reset());

  // ---- main loop -------------------------------------------------------

  let last = performance.now();
  let acc = 0;
  let frame = 0;
  function loop(now: number): void {
    const dt = app.replay ? sim.cfg.dt : evo.cfg.sim.dt;
    acc += Math.min(now - last, 100) / 1000;
    last = now;
    if (!app.paused) {
      if (app.speed === "skip") {
        const end = performance.now() + 12;
        while (performance.now() < end) app.step();
        acc = 0;
      } else {
        let n = Math.min(MAX_STEPS_PER_FRAME, Math.floor(acc / dt) * app.speed);
        acc -= Math.floor(acc / dt) * dt;
        while (n-- > 0) app.step();
      }
    }
    frame++;
    if (app.speed !== "skip" || frame % 20 === 0) app.render();
    if (frame % 6 === 0) updateStats();
    $("status").textContent = app.speed === "skip" && !app.paused ? "Skipping render: simulating as fast as possible." : "";
    requestAnimationFrame(loop);
  }

  drawChart();
  renderHof();
  updateSeeds();
  window.addEventListener("resize", () => app.render());
  requestAnimationFrame(loop);
  return app;
}

if (typeof document !== "undefined" && document.getElementById("stage")) {
  (window as unknown as { app: App }).app = createApp();
}
