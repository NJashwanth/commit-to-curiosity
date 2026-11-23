// Saves the three README screenshots with headless Chromium (Playwright).
//   npm run dev            (in one terminal)
//   node tools/screenshots.mjs docs/best-car.json
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const bestCar = process.argv[2] ?? "docs/best-car.json";
const MID_GENERATIONS = Number(process.env.MID_GENERATIONS ?? 20);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("page error:", e));

// 1. Generation 1: a random population on the start line, a few seconds in.
await page.goto(`${BASE}/?seed=42`);
await page.click('button[data-speed="4"]');
await page.waitForFunction(() => app.sim.time > 7);
await page.click("#b-pause");
await page.screenshot({ path: "docs/01-generation-1-chaos.png" });

// 2. A mid-run generation with the fitness chart filled in.
await page.click("#b-pause");
await page.click('button[data-speed="skip"]');
await page.waitForFunction((n) => app.evo.generation > n, MID_GENERATIONS, { timeout: 600_000 });
await page.click('button[data-speed="4"]');
await page.waitForFunction(() => app.sim.time > 12);
await page.click("#b-pause");
await page.screenshot({ path: "docs/02-mid-run-fitness-chart.png" });

// 3. Import the exported best car and replay it from the hall of fame, paused
//    when it is deepest into the track (the steepest, roughest stretch).
await page.click("#b-pause");
await page.setInputFiles("#h-import", bestCar);
await page.waitForFunction(() => document.querySelector("#h-msg").textContent.startsWith("Imported"));
await page.click("#h-list .hof-row:last-child button"); // the imported entry is the last row
await page.click('button[data-speed="16"]');
const best = await page.evaluate(() => app.hof.entries.at(-1).distance);
await page.waitForFunction((b) => app.replay.entries[0].life.distance >= b * 0.96 || !app.replay.entries[0].life.alive, best, { timeout: 120_000 });
await page.click("#b-pause");
await page.waitForTimeout(400);
await page.screenshot({ path: "docs/03-hall-of-fame-hardest-terrain.png" });

await browser.close();
