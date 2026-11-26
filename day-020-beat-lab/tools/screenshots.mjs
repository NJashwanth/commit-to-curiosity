// Makes the README assets with headless Chromium (Playwright):
//   npm run dev            (in one terminal)
//   node tools/screenshots.mjs
// Saves docs/01-grid-commit-to-curiosity.png, docs/02-synth-panel.png and
// docs/commit-to-curiosity.wav (the preset, rendered offline through the Export button),
// then checks the WAV: header, duration, that the browser can decode and play it, and that it is not silent.
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("page error:", e));

// A fresh profile starts on the commit-to-curiosity preset. Wait for pattern C (the melody) to be playing.
await page.goto(BASE);
await page.click(".play");
await page.waitForFunction(() => document.querySelector(".slot.playing")?.textContent === "C", null, { timeout: 30_000 });
// Show the pattern that is playing (C, the melody) in the grid.
await page.click('.slot:has-text("C")');
await page.waitForTimeout(500);
await page.screenshot({ path: "docs/01-grid-commit-to-curiosity.png", fullPage: true });

// The synth panel: select the synth track and shoot the grid's synth row plus its parameters.
await page.keyboard.press("9");
await page.waitForTimeout(150);
await page.locator(".panel").first().screenshot({ path: "docs/02-synth-panel.png" });
await page.keyboard.press("Space");

// Export through the real button.
const [download] = await Promise.all([page.waitForEvent("download"), page.click("text=Export WAV")]);
await download.saveAs("docs/commit-to-curiosity.wav");

const buf = fs.readFileSync("docs/commit-to-curiosity.wav");
const rate = buf.readUInt32LE(24);
const channels = buf.readUInt16LE(22);
const dataBytes = buf.readUInt32LE(40);
console.log(`header: ${buf.toString("ascii", 0, 4)}/${buf.toString("ascii", 8, 12)}, ${channels} ch, ${rate} Hz, ${buf.readUInt16LE(34)}-bit`);
console.log(`size: ${(buf.length / 1e6).toFixed(2)} MB, RIFF size ok: ${buf.readUInt32LE(4) === buf.length - 8}, data size ok: ${dataBytes === buf.length - 44}`);
console.log(`duration from header: ${(dataBytes / buf.readUInt32LE(28)).toFixed(3)} s`);

// Can a browser decode it and play it?
const b64 = buf.toString("base64");
const verdict = await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
  let peak = 0;
  let sumsq = 0;
  const d = decoded.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    peak = Math.max(peak, Math.abs(d[i]));
    sumsq += d[i] * d[i];
  }
  // loudness per second, to show the build-up from pattern A to D
  const perSecond = [];
  for (let s = 0; s + decoded.sampleRate <= d.length; s += decoded.sampleRate) {
    let e = 0;
    for (let i = s; i < s + decoded.sampleRate; i++) e += d[i] * d[i];
    perSecond.push(Number(Math.sqrt(e / decoded.sampleRate).toFixed(3)));
  }
  const audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
  await audio.play();
  await new Promise((r) => setTimeout(r, 1200));
  const played = { currentTime: audio.currentTime, paused: audio.paused, duration: audio.duration };
  audio.pause();
  return { decodedSeconds: decoded.duration, channels: decoded.numberOfChannels, peak, rms: Math.sqrt(sumsq / d.length), perSecond, played };
}, b64);
console.log("browser decode:", JSON.stringify(verdict, null, 1));
await browser.close();
