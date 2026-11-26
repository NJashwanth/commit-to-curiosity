import "./style.css";
import { AudioApp } from "./engine";
import { Sequencer } from "./sequencer";
import { createDefaultState, type BeatState } from "./state";
import { UI } from "./ui";

/** A small four-on-the-floor starter so the first Play makes noise. Presets replace this. */
function starterBeat(): BeatState {
  const s = createDefaultState();
  const p = s.patterns[0];
  const on = (row: { on: boolean }[], steps: number[]) => steps.forEach((i) => (row[i].on = true));
  on(p.drums[0], [0, 4, 8, 12]);
  on(p.drums[1], [4, 12]);
  on(p.drums[2], [0, 2, 4, 6, 8, 10, 12, 14]);
  on(p.drums[3], [6, 14]);
  [0, 3, 6, 8, 11].forEach((i, n) => Object.assign(p.synth[i], { on: true, note: [36, 36, 39, 41, 43][n] }));
  s.tempo = 110;
  return s;
}

const seq = new Sequencer(starterBeat());
const app = new AudioApp(seq);
const root = document.querySelector<HTMLElement>("#app")!;
new UI(root, app);

// Handy for poking at from the console and for the screenshot script.
(window as unknown as { beatlab: unknown }).beatlab = { seq, app };
