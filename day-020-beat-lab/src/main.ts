// Scaffold entry point: proves the audio context wiring works. The real
// sequencer UI replaces this once the engine modules exist.
import { createAudioContext, ensureRunning, midiToFreq } from "./audio-context";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <h1>Beat Lab</h1>
  <p id="status">Audio is off. Browsers need a click first.</p>
  <button id="start">Start audio</button>
  <button id="beep" disabled>Test tone</button>
`;

const status = app.querySelector<HTMLParagraphElement>("#status")!;
let ctx: AudioContext | null = null;

app.querySelector<HTMLButtonElement>("#start")!.addEventListener("click", async () => {
  try {
    ctx ??= createAudioContext();
    const ok = await ensureRunning(ctx);
    status.textContent = ok ? `Audio running at ${ctx.sampleRate} Hz` : "Could not start audio.";
    app.querySelector<HTMLButtonElement>("#beep")!.disabled = !ok;
  } catch (err) {
    status.textContent = (err as Error).message;
  }
});

app.querySelector<HTMLButtonElement>("#beep")!.addEventListener("click", () => {
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.frequency.value = midiToFreq(69);
  amp.gain.setValueAtTime(0.2, t);
  amp.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.35);
});
