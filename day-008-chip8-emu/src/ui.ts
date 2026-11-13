import { Beeper } from "./audio";
import { Cpu } from "./cpu";
import { HEIGHT, WIDTH, parseColor, toRGBA, type RGB } from "./display";
import { hex } from "./hex";
import { bindKeyboard, buildTouchKeypad, isTextEntry } from "./input";
import { Machine } from "./machine";
import { PRESETS, PRESET_LABELS, QUIRK_INFO, matchPreset, type PresetName, type Quirks } from "./quirks";
import {
  SPEED_STEPS,
  browserStorage,
  loadSettings,
  saveSettings,
  speedStepFor,
  type Settings,
} from "./settings";

export type RunState = "empty" | "running" | "paused" | "error";

/** Per-ROM defaults applied when it loads. */
export interface RomProfile {
  quirks?: Partial<Quirks>;
  cyclesPerFrame?: number;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

/**
 * Owns the emulator and the page: the requestAnimationFrame loop, painting,
 * input, sound, settings and ROM loading. Panels like the debugger subscribe
 * to changes instead of reaching into the DOM here.
 */
export class App {
  readonly settings: Settings;
  readonly cpu: Cpu;
  readonly machine: Machine;
  readonly beeper = new Beeper();
  state: RunState = "empty";
  romName = "";
  error: Error | null = null;

  private readonly storage = browserStorage();
  private rom: Uint8Array | null = null;
  private lastTime: number | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private onRGB: RGB;
  private offRGB: RGB;
  private keyButtons: HTMLButtonElement[] = [];
  private readonly shownKeys: boolean[] = new Array(16).fill(false);
  private statusText = "";

  private readonly el = {
    screenWrap: byId("screen-wrap"),
    canvas: byId<HTMLCanvasElement>("screen"),
    message: byId("screen-msg"),
    status: byId("status"),
    file: byId<HTMLInputElement>("rom-file"),
    run: byId<HTMLButtonElement>("btn-run"),
    reset: byId<HTMLButtonElement>("btn-reset"),
    mute: byId<HTMLButtonElement>("btn-mute"),
    keypad: byId("keypad"),
    speed: byId<HTMLInputElement>("speed"),
    speedOut: byId<HTMLOutputElement>("speed-out"),
    preset: byId<HTMLSelectElement>("preset"),
    quirks: byId("quirks"),
    colorOn: byId<HTMLInputElement>("color-on"),
    colorOff: byId<HTMLInputElement>("color-off"),
  };

  constructor() {
    this.settings = loadSettings(this.storage);
    this.cpu = new Cpu();
    // The settings object is the single source of truth for quirk flags.
    this.cpu.quirks = this.settings.quirks;
    this.machine = new Machine(this.cpu, this.settings.cyclesPerFrame);
    this.beeper.muted = this.settings.muted;
    this.onRGB = parseColor(this.settings.onColor);
    this.offRGB = parseColor(this.settings.offColor);

    const ctx = this.el.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
    this.image = ctx.createImageData(WIDTH, HEIGHT);

    this.buildSettings();
    this.bindControls();
    this.bindInput();
    this.syncSettings();
    this.paint();
    this.updateChrome();
    requestAnimationFrame(this.frame);
  }

  // ---- public API (used by panels and URL handling) ----

  /** Call `fn` whenever emulator state changes, and every frame while running. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  loadRom(bytes: Uint8Array, name: string, profile: RomProfile = {}): void {
    try {
      this.cpu.load(bytes);
    } catch (err) {
      this.romName = name;
      this.rom = null;
      this.fail(err);
      return;
    }
    this.rom = bytes;
    this.romName = name;
    this.error = null;
    if (profile.quirks) Object.assign(this.settings.quirks, profile.quirks);
    if (profile.cyclesPerFrame) this.setSpeed(profile.cyclesPerFrame);
    this.machine.reset();
    this.syncSettings();
    this.persist();
    this.state = "running";
    this.updateChrome();
    this.notify();
  }

  /** Reload the current ROM. Stays paused if paused, so you can step from the start. */
  reset(): void {
    if (!this.rom) return;
    this.cpu.load(this.rom);
    this.machine.reset();
    this.error = null;
    this.state = this.state === "paused" ? "paused" : "running";
    this.updateChrome();
    this.notify();
  }

  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.updateChrome();
    this.notify();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.updateChrome();
    this.notify();
  }

  toggleRun(): void {
    if (this.state === "running") this.pause();
    else this.resume();
  }

  /** Execute one instruction while paused. */
  step(): void {
    if (this.state !== "paused") return;
    this.guard(() => this.machine.stepInstruction());
    this.notify();
  }

  /** Run the rest of the current frame while paused. */
  stepFrame(): void {
    if (this.state !== "paused") return;
    this.guard(() => this.machine.runFrame());
    this.notify();
  }

  // ---- the loop ----

  private readonly frame = (now: number): void => {
    // Schedule first, so nothing below can stop the loop.
    requestAnimationFrame(this.frame);
    const dt = this.lastTime === null ? 0 : now - this.lastTime;
    this.lastTime = now;
    if (this.state === "running") this.guard(() => this.machine.advance(dt));
    this.beeper.set(this.state === "running" && this.cpu.soundTimer > 0);
    if (this.cpu.display.dirty) this.paint();
    this.syncKeys();
    this.updateStatus();
    if (this.state === "running") this.notify();
  };

  private guard(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.error = err instanceof Error ? err : new Error(String(err));
    this.state = "error";
    this.beeper.set(false);
    this.updateChrome();
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        // A broken panel must not take the emulator down with it.
        console.error(err);
      }
    }
  }

  private paint(): void {
    toRGBA(this.cpu.display, this.onRGB, this.offRGB, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
    this.cpu.display.dirty = false;
  }

  // ---- chrome: buttons, status, overlay ----

  private updateChrome(): void {
    const { state, el } = this;
    const loaded = this.rom !== null;
    el.run.disabled = !loaded || state === "error";
    el.run.textContent = state === "paused" ? "Resume" : "Pause";
    el.reset.disabled = !loaded;
    el.mute.textContent = this.settings.muted ? "Sound off" : "Sound on";
    el.mute.setAttribute("aria-pressed", String(this.settings.muted));

    const msg = el.message;
    msg.classList.toggle("error", state === "error");
    if (state === "error" && this.error) {
      msg.hidden = false;
      msg.innerHTML = "";
      const p = document.createElement("p");
      p.textContent = `${this.error.message}. ${loaded ? "Press Reset to start over." : ""}`;
      msg.append(p);
    } else {
      msg.hidden = state !== "empty";
    }
    this.updateStatus();
  }

  private updateStatus(): void {
    const { cpu, state } = this;
    let text: string;
    if (state === "empty") text = "No ROM loaded";
    else if (state === "error") text = `${this.romName} · stopped`;
    else {
      const parts = [this.romName];
      if (state === "paused") parts.push(`paused at 0x${hex(cpu.pc, 3)}`);
      else if (cpu.waitingForKey >= 0) parts.push("waiting for a key");
      else parts.push("running");
      parts.push(`${this.machine.cyclesPerFrame} cycles/frame`);
      text = parts.join(" · ");
    }
    if (text === this.statusText) return;
    this.statusText = text;
    this.el.status.textContent = text;
    this.el.status.classList.toggle("error", state === "error");
  }

  // ---- settings panel ----

  private buildSettings(): void {
    const { el } = this;
    el.speed.max = String(SPEED_STEPS.length - 1);

    for (const name of Object.keys(PRESETS) as PresetName[]) {
      el.preset.append(new Option(PRESET_LABELS[name], name));
    }
    const custom = new Option("Custom", "custom");
    custom.disabled = true;
    el.preset.append(custom);

    for (const { key, label, help } of QUIRK_INFO) {
      const row = document.createElement("label");
      row.className = "quirk";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.quirk = key;
      const name = document.createElement("span");
      name.textContent = label;
      const small = document.createElement("small");
      small.textContent = help;
      row.append(box, name, small);
      el.quirks.append(row);
      box.addEventListener("change", () => {
        this.settings.quirks[key] = box.checked;
        this.syncSettings();
        this.persist();
      });
    }

    el.preset.addEventListener("change", () => {
      const name = el.preset.value as PresetName;
      if (!(name in PRESETS)) return;
      Object.assign(this.settings.quirks, PRESETS[name]);
      this.syncSettings();
      this.persist();
    });

    el.speed.addEventListener("input", () => {
      this.setSpeed(SPEED_STEPS[Number(el.speed.value)]);
      this.persist();
    });

    const onColor = (which: "onColor" | "offColor", input: HTMLInputElement) => {
      input.addEventListener("input", () => {
        this.settings[which] = input.value;
        this.onRGB = parseColor(this.settings.onColor);
        this.offRGB = parseColor(this.settings.offColor);
        this.syncSettings();
        this.paint();
        this.persist();
      });
    };
    onColor("onColor", el.colorOn);
    onColor("offColor", el.colorOff);
  }

  private setSpeed(cyclesPerFrame: number): void {
    this.machine.cyclesPerFrame = cyclesPerFrame;
    this.settings.cyclesPerFrame = this.machine.cyclesPerFrame;
    this.syncSettings();
  }

  /** Reflect the settings object in every control. */
  private syncSettings(): void {
    const { el, settings } = this;
    el.speed.value = String(speedStepFor(settings.cyclesPerFrame));
    el.speedOut.value = `${settings.cyclesPerFrame} / frame`;
    el.preset.value = matchPreset(settings.quirks);
    for (const box of el.quirks.querySelectorAll<HTMLInputElement>("input[data-quirk]")) {
      box.checked = settings.quirks[box.dataset.quirk as keyof Quirks];
    }
    el.colorOn.value = settings.onColor;
    el.colorOff.value = settings.offColor;
    document.documentElement.style.setProperty("--pixel-off", settings.offColor);
  }

  private persist(): void {
    saveSettings(this.storage, this.settings);
  }

  // ---- controls and input ----

  private bindControls(): void {
    const { el } = this;
    el.run.addEventListener("click", () => this.toggleRun());
    el.reset.addEventListener("click", () => this.reset());
    el.mute.addEventListener("click", () => this.toggleMute());

    el.file.addEventListener("change", async () => {
      const file = el.file.files?.[0];
      if (file) await this.loadFile(file);
      el.file.value = "";
    });

    el.screenWrap.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.screenWrap.classList.add("dragging");
    });
    el.screenWrap.addEventListener("dragleave", () => el.screenWrap.classList.remove("dragging"));
    el.screenWrap.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.screenWrap.classList.remove("dragging");
      const file = e.dataTransfer?.files[0];
      if (file) await this.loadFile(file);
    });
  }

  private async loadFile(file: File): Promise<void> {
    this.beeper.unlock();
    this.loadRom(new Uint8Array(await file.arrayBuffer()), file.name);
  }

  private toggleMute(): void {
    this.settings.muted = !this.settings.muted;
    this.beeper.muted = this.settings.muted;
    this.persist();
    this.updateChrome();
  }

  private bindInput(): void {
    const handlers = {
      down: (key: number) => {
        this.beeper.unlock();
        this.cpu.keyDown(key);
      },
      up: (key: number) => this.cpu.keyUp(key),
    };
    bindKeyboard(window, handlers);
    this.keyButtons = buildTouchKeypad(this.el.keypad, handlers);

    // Shortcuts that are not on the CHIP-8 keypad.
    window.addEventListener("keydown", (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
      if (e.code === "KeyP") this.toggleRun();
      else if (e.code === "KeyM") this.toggleMute();
      else if (e.code === "KeyN") this.step();
      else return;
      e.preventDefault();
    });

    // Browsers block audio until the user interacts with the page.
    window.addEventListener("pointerdown", () => this.beeper.unlock());
    // Don't leave keys stuck down when the window loses focus.
    window.addEventListener("blur", () => this.cpu.releaseAllKeys());
  }

  /** Light up on-screen keys that are held, whatever is holding them. */
  private syncKeys(): void {
    for (let k = 0; k < 16; k++) {
      const down = this.cpu.keys[k];
      if (down === this.shownKeys[k]) continue;
      this.shownKeys[k] = down;
      this.keyButtons[k]?.classList.toggle("down", down);
    }
  }
}
