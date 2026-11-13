import { STACK_DEPTH } from "./cpu";
import { disassembleAround, explain, hexDump } from "./disasm";
import { hex } from "./hex";
import type { App } from "./ui";

const REFRESH_MS_WHILE_RUNNING = 100;
const DISASM_BEFORE = 6;
const DISASM_AFTER = 10;
const MEMORY_ROWS = 16;
const MEMORY_COLS = 8;

type Follow = "pc" | "i" | "manual";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

/** Register values worth flagging when they change between updates. */
function snapshot(app: App): number[] {
  const { cpu } = app;
  return [...cpu.v, cpu.i, cpu.pc, cpu.sp, cpu.delayTimer, cpu.soundTimer];
}

/**
 * The debugger panel: run/pause, single step, step a frame, registers,
 * stack, the current opcode, disassembly around PC and a memory viewer.
 * It redraws on every change while paused and ten times a second while running.
 */
export class DebuggerPanel {
  private readonly el = {
    panel: byId<HTMLDetailsElement>("debugger"),
    run: byId<HTMLButtonElement>("dbg-run"),
    step: byId<HTMLButtonElement>("dbg-step"),
    frame: byId<HTMLButtonElement>("dbg-frame"),
    current: byId("dbg-current"),
    regs: byId("dbg-regs"),
    stack: byId("dbg-stack"),
    disasm: byId("dbg-disasm"),
    memAddr: byId<HTMLInputElement>("mem-addr"),
    memory: byId("dbg-memory"),
  };
  private follow: Follow = "pc";
  private memStart = 0x200;
  private lastDraw = 0;
  private previous: number[];
  private changed = new Set<number>();
  private wasPaused = false;

  constructor(private readonly app: App) {
    this.previous = snapshot(app);
    const { el } = this;
    el.run.addEventListener("click", () => app.toggleRun());
    el.step.addEventListener("click", () => app.step());
    el.frame.addEventListener("click", () => app.stepFrame());
    el.panel.addEventListener("toggle", () => this.render(true));

    for (const button of el.panel.querySelectorAll<HTMLButtonElement>("[data-follow]")) {
      button.addEventListener("click", () => {
        this.follow = button.dataset.follow as Follow;
        this.render(true);
      });
    }
    el.memAddr.addEventListener("change", () => {
      const addr = parseInt(el.memAddr.value.replace(/^0x/i, ""), 16);
      if (Number.isNaN(addr)) return;
      this.follow = "manual";
      this.memStart = Math.max(0, Math.min(0xfff, addr));
      this.render(true);
    });
    // Clicking a disassembly line shows that address in the memory viewer.
    el.disasm.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[data-addr]");
      if (!li) return;
      this.follow = "manual";
      this.memStart = Number(li.dataset.addr);
      this.render(true);
    });

    app.subscribe(() => this.render(false));
    this.render(true);
  }

  private render(force: boolean): void {
    const { app, el } = this;
    const running = app.state === "running";
    const now = performance.now();
    if (!force && running && now - this.lastDraw < REFRESH_MS_WHILE_RUNNING) return;

    // Track register changes even while closed, so opening shows the latest diff.
    // Highlight registers that changed between two paused moments (i.e. a step).
    const paused = app.state === "paused";
    const current = snapshot(app);
    if (paused && this.wasPaused) {
      const diff = current.flatMap((value, k) => (value !== this.previous[k] ? [k] : []));
      if (diff.length) this.changed = new Set(diff);
    } else if (!paused) {
      this.changed.clear();
    }
    this.previous = current;
    this.wasPaused = paused;

    el.run.textContent = paused ? "Resume" : "Pause";
    el.run.disabled = app.state !== "running" && !paused;
    el.step.disabled = !paused;
    el.frame.disabled = !paused;
    if (!el.panel.open) return;
    this.lastDraw = now;

    this.renderCurrent();
    this.renderRegisters(current);
    this.renderStack();
    this.renderDisassembly();
    this.renderMemory();
  }

  private renderCurrent(): void {
    const { cpu, state, error } = this.app;
    const op = cpu.fetch();
    let note = "";
    if (state === "error" && error) note = error.message;
    else if (cpu.waitingForKey >= 0) note = `Waiting for a key for V${hex(cpu.waitingForKey, 1)}`;
    else if (cpu.waitingForVblank) note = "Waiting for the next frame (display wait)";
    this.el.current.innerHTML =
      `<div class="dbg-op"><span class="dbg-addr">${hex(cpu.pc, 3)}</span>` +
      `<span class="dbg-hex">${hex(op, 4)}</span><span>${escapeHtml(explain(op))}</span></div>` +
      (note ? `<div class="dbg-note${state === "error" ? " error" : ""}">${escapeHtml(note)}</div>` : "");
  }

  private renderRegisters(values: number[]): void {
    const cell = (label: string, value: string, k: number) =>
      `<div class="reg${this.changed.has(k) ? " changed" : ""}"><span>${label}</span><b>${value}</b></div>`;
    const cells: string[] = [];
    for (let r = 0; r < 16; r++) cells.push(cell(`V${hex(r, 1)}`, hex(values[r]), r));
    cells.push(cell("I", hex(values[16], 3), 16));
    cells.push(cell("PC", hex(values[17], 3), 17));
    cells.push(cell("SP", String(values[18]), 18));
    cells.push(cell("DT", String(values[19]), 19));
    cells.push(cell("ST", String(values[20]), 20));
    this.el.regs.innerHTML = cells.join("");
  }

  private renderStack(): void {
    const { cpu } = this.app;
    const rows: string[] = [];
    for (let k = STACK_DEPTH - 1; k >= 0; k--) {
      const live = k < cpu.sp;
      const top = k === cpu.sp - 1;
      rows.push(
        `<li class="${live ? "live" : ""}${top ? " top" : ""}"><span>${hex(k, 1)}</span>${live ? hex(cpu.stack[k], 3) : "···"}</li>`,
      );
    }
    this.el.stack.innerHTML = rows.join("");
  }

  private renderDisassembly(): void {
    const { cpu } = this.app;
    const lines = disassembleAround(cpu.memory, cpu.pc, DISASM_BEFORE, DISASM_AFTER);
    this.el.disasm.innerHTML = lines
      .map(
        (l) =>
          `<li data-addr="${l.addr}"${l.addr === cpu.pc ? ' class="pc" aria-current="true"' : ""}>` +
          `<span class="dbg-addr">${hex(l.addr, 3)}</span><span class="dbg-hex">${hex(l.op, 4)}</span>` +
          `<span>${escapeHtml(l.text)}</span></li>`,
      )
      .join("");
  }

  private renderMemory(): void {
    const { cpu } = this.app;
    if (this.follow === "pc") this.memStart = cpu.pc;
    else if (this.follow === "i") this.memStart = cpu.i & 0xfff;
    if (document.activeElement !== this.el.memAddr) this.el.memAddr.value = hex(this.memStart, 3);
    for (const b of this.el.panel.querySelectorAll<HTMLButtonElement>("[data-follow]")) {
      b.setAttribute("aria-pressed", String(b.dataset.follow === this.follow));
    }

    // Center the view on the address of interest, two rows down from the top.
    const rows = hexDump(cpu.memory, this.memStart - 2 * MEMORY_COLS, MEMORY_ROWS, MEMORY_COLS);
    const iAddr = cpu.i & 0xfff;
    this.el.memory.innerHTML = rows
      .map(({ addr, bytes }) => {
        const cells = bytes.map((b, k) => {
          const a = addr + k;
          const cls = a === cpu.pc || a === cpu.pc + 1 ? "pc" : a === iAddr ? "i" : "";
          return cls ? `<span class="${cls}">${hex(b)}</span>` : hex(b);
        });
        return `<span class="dbg-addr">${hex(addr, 3)}</span> ${cells.join(" ")}`;
      })
      .join("\n");
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}
