import "./style.css";
import { DebuggerPanel } from "./debugger";
import { BUILT_IN_ROMS, DEFAULT_ROM_ID, findRom, romUrl, type BuiltInRom } from "./roms";
import { App } from "./ui";

const app = new App();
new DebuggerPanel(app);

const select = document.getElementById("rom-select") as HTMLSelectElement;
const info = document.getElementById("rom-info") as HTMLElement;
const params = new URLSearchParams(location.search);

// The dropdown: my own ROMs first, then the CC0 archive games.
const groups: Array<[string, BuiltInRom["origin"]]> = [
  ["Written for this project", "own"],
  ["CHIP-8 Archive (CC0)", "chip8-archive"],
];
select.append(new Option("Built-in ROMs…", ""));
for (const [label, origin] of groups) {
  const group = document.createElement("optgroup");
  group.label = label;
  for (const rom of BUILT_IN_ROMS.filter((r) => r.origin === origin)) group.append(new Option(rom.title, rom.id));
  select.append(group);
}

function showInfo(rom: BuiltInRom | undefined): void {
  info.innerHTML = "";
  if (!rom) return;
  const by = document.createElement("span");
  by.className = "by";
  by.textContent = ` by ${rom.author} · `;
  const title = document.createElement("strong");
  title.textContent = rom.title;
  info.append(title, by, rom.controls);
}

let fetching = false;

async function loadBuiltIn(rom: BuiltInRom): Promise<void> {
  select.value = rom.id;
  showInfo(rom);
  fetching = true;
  try {
    const res = await fetch(romUrl(rom, import.meta.env.BASE_URL));
    if (!res.ok) throw new Error(`Could not load ${rom.file} (HTTP ${res.status})`);
    app.loadRom(new Uint8Array(await res.arrayBuffer()), rom.title, rom.profile);
  } catch (err) {
    app.fail(err);
  } finally {
    fetching = false;
  }
  // Keep the address shareable: ?rom=<id>, preserving other parameters.
  params.set("rom", rom.id);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

select.addEventListener("change", () => {
  const rom = findRom(select.value);
  if (!rom) return;
  app.beeper.unlock();
  void loadBuiltIn(rom);
});

// A ROM opened from disk is not one of ours: clear the dropdown and info line.
app.subscribe(() => {
  if (fetching) return;
  const current = findRom(select.value);
  if (current && app.romName !== current.title) {
    select.value = "";
    showInfo(undefined);
    params.delete("rom");
    history.replaceState(null, "", params.size ? `${location.pathname}?${params}` : location.pathname);
  }
});

// ?debug opens the debugger panel on load.
if (params.has("debug")) {
  (document.getElementById("debugger") as HTMLDetailsElement).open = true;
}

// Start with ?rom=<id>, or the demo so the screen is never blank.
void loadBuiltIn(findRom(params.get("rom")) ?? findRom(DEFAULT_ROM_ID)!);

// Handy from the browser console: inspect or poke the running machine.
(window as unknown as { chip8: App }).chip8 = app;
