// Toolbar glue: presets, save/load, share link and WAV export. All the logic
// (codec, store, renderer) is in tested modules; this only wires buttons.
import type { AudioApp } from "./engine";
import { PRESETS, loadPreset } from "./presets";
import { renderWav } from "./render";
import type { BeatStore } from "./storage";
import { CodecError, hashToState, stateToHash } from "./url-codec";
import type { UI } from "./ui";

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function download(bytes: Uint8Array<ArrayBuffer>, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function mountTools(ui: UI, app: AudioApp, store: BeatStore): void {
  const { seq } = app;
  const bar = ui.toolbar;

  const presets = document.createElement("select");
  presets.setAttribute("aria-label", "Load a preset beat");
  presets.append(new Option("Presets", ""));
  for (const p of PRESETS) presets.append(new Option(p.name, p.id));
  presets.addEventListener("change", () => {
    const state = loadPreset(presets.value);
    if (state) {
      seq.load(state);
      ui.setStatus(PRESETS.find((p) => p.id === presets.value)!.description);
    }
    presets.value = "";
  });

  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "name";
  name.maxLength = 40;
  name.size = 10;
  name.setAttribute("aria-label", "Name for saving this beat");

  const saved = document.createElement("select");
  saved.setAttribute("aria-label", "Load a saved beat");
  const refreshSaved = () => {
    saved.replaceChildren(new Option(`Saved (${store.list().length})`, ""));
    for (const b of store.list()) saved.append(new Option(b.name, b.name));
  };
  saved.addEventListener("change", () => {
    const state = store.load(saved.value);
    if (state) {
      seq.load(state);
      name.value = saved.value;
      ui.setStatus(`Loaded "${saved.value}".`);
    } else if (saved.value) ui.setStatus("That saved beat could not be read.");
    saved.value = "";
  });

  const save = button("Save", "Save in this browser", () => {
    const r = store.save(name.value, seq.state);
    ui.setStatus(r.message);
    refreshSaved();
  });

  const share = button("Share link", "Copy a link that recreates this beat", async () => {
    const url = `${location.origin}${location.pathname}${stateToHash(seq.state)}`;
    history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url);
      ui.setStatus(`Link copied (${url.length} characters). Anyone who opens it gets this exact beat.`);
    } catch {
      ui.setStatus("The link is now in the address bar. Copy it from there.");
    }
  });

  const exportBtn = button("Export WAV", "Render 4 bars to a 16-bit WAV file", async () => {
    exportBtn.disabled = true;
    ui.setStatus("Rendering 4 bars...");
    try {
      const wav = await renderWav(seq.state);
      download(wav, `beat-lab-${seq.state.tempo}bpm.wav`);
      ui.setStatus(`Exported ${(wav.length / 1024 / 1024).toFixed(2)} MB.`);
    } catch (e) {
      ui.setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      exportBtn.disabled = false;
    }
  });

  bar.append(presets, name, save, saved, share, exportBtn);
  refreshSaved();

  // Keep the last beat across reloads.
  let timer: ReturnType<typeof setTimeout> | undefined;
  seq.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => store.autosave(seq.state), 400);
  });

  // Pasting a different share link into the same tab loads it.
  window.addEventListener("hashchange", () => {
    try {
      const state = hashToState(location.hash);
      if (state) {
        seq.load(state);
        ui.setStatus("Loaded the beat from the link.");
      }
    } catch (e) {
      ui.setStatus(e instanceof CodecError ? e.message : "That link could not be read.");
    }
  });
}
