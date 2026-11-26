import "./style.css";
import { AudioApp } from "./engine";
import { loadPreset } from "./presets";
import { Sequencer } from "./sequencer";
import { BeatStore, chooseInitial } from "./storage";
import { mountTools } from "./tools";
import { UI } from "./ui";

const store = new BeatStore();
const initial = chooseInitial(location.hash, store, () => loadPreset("commit-to-curiosity")!);

const seq = new Sequencer(initial.state);
const app = new AudioApp(seq);
const ui = new UI(document.querySelector<HTMLElement>("#app")!, app);
mountTools(ui, app, store);

if (initial.error) ui.setStatus(`${initial.error} Starting with ${initial.source === "autosave" ? "your last beat" : "the default beat"} instead.`);
else if (initial.source === "link") ui.setStatus("Loaded the beat from the link. Press Play or hit space.");
if (!store.persistent) ui.setStatus("This browser blocks storage, so saves last only for this visit. Share links still work.");

// Handy for poking at from the console and for the screenshot script.
(window as unknown as { beatlab: unknown }).beatlab = { seq, app, store };
