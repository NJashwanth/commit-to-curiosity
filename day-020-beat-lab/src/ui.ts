// The DOM layer. Everything with logic in it lives in the tested modules
// (sequencer, controls, engine); this file only builds elements, forwards
// events to them and repaints from state.
import { DRUM_LABELS } from "./drums";
import {
  DRAG_PIXELS_PER_NOTE,
  DRUM_KNOBS,
  FX_KNOBS,
  SLOT_NAMES,
  SWING_RANGE,
  SYNTH_KNOBS,
  TEMPO_RANGE,
  TRACK_HUES,
  delayDivisionLabel,
  keyAction,
  nextVelocity,
  noteFromDrag,
  trackName,
  wrapSlot,
  type KnobSpec,
} from "./controls";
import { midiToName } from "./audio-context";
import type { AudioApp, PlayheadEvent } from "./engine";
import type { Sequencer } from "./sequencer";
import { DELAY_DIVISIONS, LENGTHS, PATTERN_COUNT, STEP_COUNT, SYNTH_TRACK, TRACK_COUNT } from "./state";
import { WAVES, WAVE_LABELS } from "./synth";
import { Visualizer } from "./visualizer";

type Tool = "step" | "velocity" | "accent";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("data-") || k.startsWith("aria-") || k === "title" || k === "type" || k === "id") node.setAttribute(k, String(v));
    else (node as unknown as Record<string, unknown>)[k] = v;
  }
  for (const kid of kids) node.append(kid);
  return node;
}

export class UI {
  private readonly seq: Sequencer;
  private selected = 0;
  private tool: Tool = "step";
  private playStep = -1;
  private playSlot = -1;
  private queue: PlayheadEvent[] = [];
  private cells: HTMLButtonElement[][] = [];
  private rows: HTMLElement[] = [];
  private visualizer: Visualizer | null = null;
  private knobInputs = new Map<string, { input: HTMLInputElement; out: HTMLOutputElement; spec: KnobSpec }>();

  private playBtn!: HTMLButtonElement;
  private tempo!: HTMLInputElement;
  private tempoOut!: HTMLOutputElement;
  private swing!: HTMLInputElement;
  private swingOut!: HTMLOutputElement;
  private slotBtns: HTMLButtonElement[] = [];
  private lengthBtns: HTMLButtonElement[] = [];
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private copySel!: HTMLSelectElement;
  private chainBox!: HTMLInputElement;
  private chainChips!: HTMLElement;
  private grid!: HTMLElement;
  private panel!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private status!: HTMLElement;
  /** Where optional tools (presets, save, share, export) mount. */
  readonly toolbar: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly app: AudioApp,
  ) {
    this.seq = app.seq;
    this.toolbar = el("div", { class: "toolbar" });
    this.build();
    this.seq.subscribe(() => this.refresh());
    app.onPlayhead((e) => this.queue.push(e));
    document.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("resize", () => this.sizeCanvas());
    this.buildTrackPanel();
    this.sizeCanvas();
    requestAnimationFrame(() => this.frame());
  }

  setStatus(msg: string): void {
    this.status.textContent = msg;
  }

  // ---------- building ----------

  private build(): void {
    this.playBtn = el("button", { class: "play", type: "button", text: "Play", "aria-label": "Play or stop (space)" });
    this.playBtn.addEventListener("click", () => void this.togglePlay());
    this.tempo = el("input", { type: "range", min: String(TEMPO_RANGE.min), max: String(TEMPO_RANGE.max), "aria-label": "Tempo" });
    this.tempoOut = el("output");
    this.tempo.addEventListener("input", () => this.seq.setTempo(Number(this.tempo.value)));
    this.swing = el("input", { type: "range", min: String(SWING_RANGE.min), max: String(SWING_RANGE.max), "aria-label": "Swing" });
    this.swingOut = el("output");
    this.swing.addEventListener("input", () => this.seq.setSwing(Number(this.swing.value)));
    this.status = el("div", { class: "status", role: "status", "aria-live": "polite" });

    const header = el(
      "header",
      { class: "top" },
      el("h1", { text: "Beat Lab" }),
      el(
        "div",
        { class: "transport" },
        this.playBtn,
        el("label", { class: "slider" }, el("span", { text: "Tempo" }), this.tempo, this.tempoOut),
        el("label", { class: "slider" }, el("span", { text: "Swing" }), this.swing, this.swingOut),
      ),
      this.toolbar,
    );

    this.root.replaceChildren(header, this.status, this.buildPatternBar(), this.buildGrid(), this.buildPanels(), this.buildVisualizer());
  }

  private buildPatternBar(): HTMLElement {
    const slots = el("div", { class: "group", role: "group", "aria-label": "Pattern slot" });
    SLOT_NAMES.forEach((name, i) => {
      const b = el("button", { type: "button", class: "slot", text: name, "aria-label": `Pattern ${name}` });
      b.addEventListener("click", () => this.seq.selectPattern(i));
      this.slotBtns.push(b);
      slots.append(b);
    });

    const lengths = el("div", { class: "group", role: "group", "aria-label": "Pattern length" });
    for (const len of LENGTHS) {
      const b = el("button", { type: "button", text: `${len}`, "aria-label": `${len} steps` });
      b.addEventListener("click", () => this.seq.setLength(len));
      this.lengthBtns.push(b);
      lengths.append(b);
    }

    this.copySel = el("select", { "aria-label": "Copy this pattern to another slot" });
    this.copySel.addEventListener("change", () => {
      const to = Number(this.copySel.value);
      if (!Number.isNaN(to) && this.copySel.value !== "") this.seq.copyPattern(this.seq.state.current, to);
      this.copySel.value = "";
    });
    const clear = el("button", { type: "button", text: "Clear" });
    clear.addEventListener("click", () => this.seq.clearPattern(this.seq.state.current));

    this.chainBox = el("input", { type: "checkbox", "aria-label": "Chain mode" });
    this.chainBox.addEventListener("change", () => this.seq.setChainMode(this.chainBox.checked));
    this.chainChips = el("span", { class: "chips" });
    const chainAdd = el("div", { class: "group", role: "group", "aria-label": "Add to chain" });
    SLOT_NAMES.forEach((name, i) => {
      const b = el("button", { type: "button", text: `+${name}`, title: `Add ${name} to the chain` });
      b.addEventListener("click", () => this.seq.appendChain(i));
      chainAdd.append(b);
    });
    const undo = el("button", { type: "button", text: "Undo", title: "Remove the last chain entry" });
    undo.addEventListener("click", () => this.seq.popChain());
    const wipe = el("button", { type: "button", text: "Reset", title: "Empty the chain" });
    wipe.addEventListener("click", () => this.seq.clearChain());

    const tools = el("div", { class: "group", role: "group", "aria-label": "What a tap on a step does" });
    for (const [tool, label] of [["step", "Step"], ["velocity", "Velocity"], ["accent", "Accent"]] as Array<[Tool, string]>) {
      const b = el("button", { type: "button", text: label, title: tool === "step" ? "Tap toggles steps; drag to paint" : tool === "velocity" ? "Tap cycles soft to loud" : "Tap toggles an accent" });
      b.addEventListener("click", () => {
        this.tool = tool;
        this.refresh();
      });
      this.toolBtns.set(tool, b);
      tools.append(b);
    }

    return el(
      "section",
      { class: "bar" },
      el("div", { class: "field" }, el("span", { class: "lbl", text: "Pattern" }), slots),
      el("div", { class: "field" }, el("span", { class: "lbl", text: "Steps" }), lengths),
      el("div", { class: "field" }, el("span", { class: "lbl", text: "Copy to" }), this.copySel, clear),
      el("div", { class: "field" }, el("label", { class: "lbl check" }, this.chainBox, "Chain"), this.chainChips, chainAdd, undo, wipe),
      el("div", { class: "field" }, el("span", { class: "lbl", text: "Tap sets" }), tools),
    );
  }

  private buildGrid(): HTMLElement {
    this.grid = el("div", { class: "grid", role: "grid", "aria-label": "Step sequencer" });
    for (let t = 0; t < TRACK_COUNT; t++) {
      const row = el("div", { class: "row", "data-track": t });
      row.style.setProperty("--h", String(TRACK_HUES[t]));
      const name = el("button", { type: "button", class: "name", text: trackName(t, DRUM_LABELS), title: "Select (and hear) this track" });
      name.addEventListener("click", () => {
        this.select(t);
        void this.app.audition(t);
      });
      const mute = el("button", { type: "button", class: "ms m", text: "M", title: "Mute", "aria-label": `Mute ${trackName(t, DRUM_LABELS)}` });
      mute.addEventListener("click", () => this.seq.toggleMute(t));
      const solo = el("button", { type: "button", class: "ms s", text: "S", title: "Solo", "aria-label": `Solo ${trackName(t, DRUM_LABELS)}` });
      solo.addEventListener("click", () => this.seq.toggleSolo(t));
      row.append(name, mute, solo);
      const line: HTMLButtonElement[] = [];
      for (let s = 0; s < STEP_COUNT; s++) {
        const c = el("button", { type: "button", class: "cell", "data-step": s, "aria-label": `${trackName(t, DRUM_LABELS)} step ${s + 1}` });
        line.push(c);
        row.append(c);
      }
      this.cells.push(line);
      this.rows.push(row);
      this.grid.append(row);
    }
    this.grid.addEventListener("pointerdown", (e) => this.onCellDown(e));
    this.grid.addEventListener("click", (e) => this.onCellClick(e));
    this.grid.addEventListener("wheel", (e) => this.onCellWheel(e), { passive: false });
    return el("div", { class: "grid-wrap" }, this.grid);
  }

  private buildPanels(): HTMLElement {
    this.panel = el("section", { class: "panel" });
    const fx = el("section", { class: "panel" }, el("h2", { text: "Effects" }));
    const wrap = el("div", { class: "knobs" });
    const divSel = el("select", { "aria-label": "Delay time" });
    DELAY_DIVISIONS.forEach((_, i) => divSel.append(el("option", { value: String(i), text: delayDivisionLabel(i) })));
    divSel.addEventListener("change", () => this.seq.setFx("delayDiv", Number(divSel.value)));
    wrap.append(el("label", { class: "knob" }, el("span", { text: "Delay time" }), divSel, el("output", { text: "synced" })));
    this.delaySelect = divSel;
    for (const spec of FX_KNOBS) wrap.append(this.knob(`fx.${spec.key}`, spec, (v) => this.seq.setFx(spec.key, v)));
    fx.append(wrap);
    return el("div", { class: "panels" }, this.panel, fx);
  }
  private delaySelect!: HTMLSelectElement;

  private buildVisualizer(): HTMLElement {
    this.canvas = el("canvas", { class: "viz", "aria-label": "Spectrum analyser", role: "img" });
    this.visualizer = new Visualizer(this.canvas, () => this.app.analyser);
    return el("section", { class: "panel" }, this.canvas);
  }

  /** A labelled 0..100 slider that writes through `set` and reads back in refresh(). */
  private knob(id: string, spec: KnobSpec, set: (v: number) => void, max = 100): HTMLElement {
    const input = el("input", { type: "range", min: "0", max: String(max), step: "1", "aria-label": spec.label });
    const out = el("output");
    input.addEventListener("input", () => set(Number(input.value)));
    this.knobInputs.set(id, { input, out, spec });
    return el("label", { class: "knob" }, el("span", { text: spec.label }), input, out);
  }

  /** Rebuild the parameter panel for the selected track. */
  private buildTrackPanel(): void {
    for (const key of [...this.knobInputs.keys()]) if (key.startsWith("track.")) this.knobInputs.delete(key);
    const t = this.selected;
    const title = el("h2", { text: `${t + 1}. ${trackName(t, DRUM_LABELS)}` });
    title.style.setProperty("color", `hsl(${TRACK_HUES[t]} 85% 62%)`);
    const wrap = el("div", { class: "knobs" });
    if (t === SYNTH_TRACK) {
      const waves = el("div", { class: "group wave", role: "group", "aria-label": "Oscillator wave" });
      WAVES.forEach((w, i) => {
        const b = el("button", { type: "button", text: WAVE_LABELS[w], "data-wave": i });
        b.addEventListener("click", () => this.seq.setSynthParam("wave", i));
        waves.append(b);
      });
      wrap.append(el("div", { class: "knob wide" }, el("span", { text: "Wave" }), waves));
      for (const spec of SYNTH_KNOBS) wrap.append(this.knob(`track.${spec.key}`, spec, (v) => this.seq.setSynthParam(spec.key, v)));
      wrap.append(el("p", { class: "hint", text: "Drag a synth step up or down to change its note. Scroll over it works too." }));
    } else {
      for (const spec of DRUM_KNOBS) wrap.append(this.knob(`track.${spec.key}`, spec, (v) => this.seq.setDrumParam(t, spec.key, v)));
    }
    this.panel.replaceChildren(title, wrap);
    this.refresh();
  }

  // ---------- behaviour ----------

  private select(track: number): void {
    this.selected = track;
    this.buildTrackPanel();
  }

  private async togglePlay(): Promise<void> {
    const playing = await this.app.toggle();
    if (!playing && !this.app.playing) {
      this.queue = [];
      this.playStep = -1;
      this.playSlot = -1;
    }
    this.refresh();
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const act = keyAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, targetTag: t?.tagName, targetType: (t as HTMLInputElement | null)?.type });
    if (!act) return;
    e.preventDefault();
    switch (act.type) {
      case "toggle-play":
        void this.togglePlay();
        break;
      case "select-track":
        this.select(act.track);
        break;
      case "mute":
        this.seq.toggleMute(this.selected);
        break;
      case "solo":
        this.seq.toggleSolo(this.selected);
        break;
      case "tempo":
        this.seq.setTempo(this.seq.state.tempo + act.delta);
        break;
      case "pattern":
        this.seq.selectPattern(wrapSlot(this.seq.state.current + act.delta));
        break;
    }
  }

  private cellInfo(e: Event): { track: number; step: number; cell: HTMLButtonElement } | null {
    const cell = (e.target as HTMLElement).closest<HTMLButtonElement>(".cell");
    if (!cell) return null;
    const track = Number(cell.closest<HTMLElement>(".row")!.dataset.track);
    return { track, step: Number(cell.dataset.step), cell };
  }

  /** Apply the current tool to one step. */
  private act(track: number, step: number): void {
    const st = track === SYNTH_TRACK ? this.seq.pattern.synth[step] : this.seq.pattern.drums[track][step];
    if (this.tool === "step" || !st.on) this.seq.toggleStep(track, step);
    else if (this.tool === "velocity") this.seq.setVelocity(track, step, nextVelocity(st.vel));
    else this.seq.toggleAccent(track, step);
  }

  private suppressClick = false;

  private onCellDown(e: PointerEvent): void {
    const info = this.cellInfo(e);
    if (!info || e.button !== 0) return;
    e.preventDefault();
    this.suppressClick = true;
    this.select(info.track);
    const { track, step } = info;

    if (track === SYNTH_TRACK) {
      const startY = e.clientY;
      const startNote = this.seq.pattern.synth[step].note;
      let dragged = false;
      const move = (m: PointerEvent) => {
        if (!dragged && Math.abs(m.clientY - startY) < DRAG_PIXELS_PER_NOTE) return;
        dragged = true;
        this.seq.setNote(step, noteFromDrag(startNote, startY, m.clientY));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (!dragged) this.act(track, step);
        else void this.app.audition(SYNTH_TRACK);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return;
    }

    // Drum rows: tap to toggle, and drag across a row to paint the same state.
    const paintOn = !this.seq.pattern.drums[track][step].on;
    this.act(track, step);
    if (this.tool !== "step") return;
    const move = (m: PointerEvent) => {
      const under = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLButtonElement>(".cell");
      if (!under || Number(under.closest<HTMLElement>(".row")!.dataset.track) !== track) return;
      const s = Number(under.dataset.step);
      if (s < this.seq.pattern.length && this.seq.pattern.drums[track][s].on !== paintOn) this.seq.toggleStep(track, s);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** Keyboard activation (Enter on a focused step) arrives as a click with no pointer. */
  private onCellClick(e: MouseEvent): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const info = this.cellInfo(e);
    if (info) this.act(info.track, info.step);
  }

  private onCellWheel(e: WheelEvent): void {
    const info = this.cellInfo(e);
    if (!info || info.track !== SYNTH_TRACK) return;
    e.preventDefault();
    this.seq.transposeStep(info.step, e.deltaY < 0 ? 1 : -1);
  }

  // ---------- painting ----------

  /** Repaint every control from the current state. */
  refresh(): void {
    const s = this.seq.state;
    const pat = this.seq.pattern;
    this.playBtn.textContent = this.app.playing ? "Stop" : "Play";
    this.playBtn.classList.toggle("on", this.app.playing);
    this.tempo.value = String(s.tempo);
    this.tempoOut.textContent = `${s.tempo} BPM`;
    this.swing.value = String(s.swing);
    this.swingOut.textContent = `${s.swing}%`;
    this.grid.style.setProperty("--steps", String(pat.length));

    this.slotBtns.forEach((b, i) => {
      b.setAttribute("aria-pressed", String(i === s.current));
      b.classList.toggle("playing", i === this.playSlot);
    });
    this.lengthBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(LENGTHS[i] === pat.length)));
    for (const [tool, b] of this.toolBtns) b.setAttribute("aria-pressed", String(tool === this.tool));
    this.chainBox.checked = s.chainMode;
    this.chainChips.replaceChildren(...s.chain.map((slot) => el("span", { class: "chip", text: SLOT_NAMES[slot] })));
    if (!s.chain.length) this.chainChips.append(el("span", { class: "muted", text: "empty" }));
    this.copySel.replaceChildren(el("option", { value: "", text: "pick slot" }));
    for (let i = 0; i < PATTERN_COUNT; i++) if (i !== s.current) this.copySel.append(el("option", { value: String(i), text: SLOT_NAMES[i] }));
    this.delaySelect.value = String(s.fx.delayDiv);

    for (let t = 0; t < TRACK_COUNT; t++) {
      const mix = t === SYNTH_TRACK ? s.synth : s.tracks[t];
      const row = this.rows[t];
      row.classList.toggle("selected", t === this.selected);
      row.classList.toggle("silent", !this.seq.isAudible(t));
      row.querySelector(".m")!.setAttribute("aria-pressed", String(mix.mute));
      row.querySelector(".s")!.setAttribute("aria-pressed", String(mix.solo));
      for (let i = 0; i < STEP_COUNT; i++) {
        const c = this.cells[t][i];
        const st = t === SYNTH_TRACK ? pat.synth[i] : pat.drums[t][i];
        c.hidden = i >= pat.length;
        c.classList.toggle("on", st.on);
        c.classList.toggle("accent", st.on && st.accent);
        c.classList.toggle("beat", i % 4 === 0);
        c.classList.toggle("now", i === this.playStep);
        c.style.setProperty("--v", st.on ? String(0.3 + (st.vel / 16) * 0.7) : "0");
        c.setAttribute("aria-pressed", String(st.on));
        c.textContent = t === SYNTH_TRACK && st.on ? midiToName(pat.synth[i].note) : "";
      }
    }

    for (const [id, k] of this.knobInputs) {
      const v = this.knobValue(id);
      if (v === undefined) continue;
      if (k.input.value !== String(v)) k.input.value = String(v);
      k.out.textContent = k.spec.format(v);
    }
    this.panel.querySelectorAll<HTMLButtonElement>("[data-wave]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.wave) === s.synth.wave)));
  }

  private knobValue(id: string): number | undefined {
    const s = this.seq.state;
    const key = id.slice(id.indexOf(".") + 1);
    if (id.startsWith("fx.")) return s.fx[key as keyof typeof s.fx];
    if (this.selected === SYNTH_TRACK) return s.synth[key as keyof typeof s.synth] as number;
    return s.tracks[this.selected][key as "tune" | "decay" | "level"];
  }

  private frame(): void {
    // Show the step that is sounding now, not the one being scheduled ahead.
    const now = this.app.currentTime - this.app.latency;
    let hit: PlayheadEvent | null = null;
    while (this.queue.length && this.queue[0].time <= now) hit = this.queue.shift()!;
    if (hit && (hit.step !== this.playStep || hit.pattern !== this.playSlot)) {
      this.cells.forEach((line) => {
        if (this.playStep >= 0) line[this.playStep].classList.remove("now");
        line[hit!.step].classList.add("now");
      });
      this.playStep = hit.step;
      if (hit.pattern !== this.playSlot) {
        this.playSlot = hit.pattern;
        this.slotBtns.forEach((b, i) => b.classList.toggle("playing", i === this.playSlot));
      }
    }
    if (!this.app.playing && this.playStep >= 0) {
      this.cells.forEach((line) => line[this.playStep]?.classList.remove("now"));
      this.playStep = -1;
      this.playSlot = -1;
      this.queue = [];
      this.slotBtns.forEach((b) => b.classList.remove("playing"));
      this.refresh();
    }
    this.visualizer!.sampleRate = this.app.sampleRate;
    this.visualizer!.draw();
    requestAnimationFrame(() => this.frame());
  }

  private sizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
  }
}
