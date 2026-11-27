// Drives the real app in headless Chromium (Playwright) and makes the README screenshots.
//   npm run dev            (in one terminal)
//   node tools/screenshots.mjs
//
// 1. Draws all ten digits with the mouse and reports what the app predicts for each.
// 2. Saves docs/01-digit-3.png, docs/02-digit-7.png and docs/03-digit-0.png: the full page after drawing,
//    showing the live prediction, the 28x28 input and both layers of feature maps.
// 3. Draws a 1 with real touch events (Chrome DevTools Protocol) to check touch input works.
// 4. Checks that Clear resets the readout.
import { createRequire } from "node:module";
import { strokesInBox } from "./digit-paths.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const SHOTS = [
  { digit: 3, file: "docs/01-digit-3.png" },
  { digit: 7, file: "docs/02-digit-7.png" },
  { digit: 0, file: "docs/03-digit-0.png" },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(BASE);
await page.waitForFunction(() => !document.getElementById("headline").textContent.includes("Loading"), null, { timeout: 30_000 });

const padBox = async () => (await page.locator("#pad").boundingBox());
// A digit occupies the middle of the canvas, like a person would draw it.
const drawBox = (pad) => ({ x: pad.x + pad.width * 0.25, y: pad.y + pad.height * 0.12, w: pad.width * 0.5, h: pad.height * 0.76 });

async function drawWithMouse(digit) {
  const box = drawBox(await padBox());
  for (const stroke of strokesInBox(digit, box)) {
    await page.mouse.move(stroke[0].x, stroke[0].y);
    await page.mouse.down();
    for (const p of stroke.slice(1)) await page.mouse.move(p.x, p.y, { steps: 2 });
    await page.mouse.up();
  }
  await page.waitForTimeout(120); // let the requestAnimationFrame update land
}

const readout = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("#bars li")].map((li) => li.querySelector(".pct").textContent);
    const top = document.querySelector("#bars li.top .digit")?.textContent ?? null;
    return { headline: document.getElementById("headline").textContent, top, rows };
  });

// 1. All ten digits.
const results = [];
for (let d = 0; d <= 9; d++) {
  await page.click("#clear");
  await drawWithMouse(d);
  const r = await readout();
  results.push({ digit: d, predicted: r.top === null ? null : Number(r.top), headline: r.headline });
}
console.log("mouse-drawn digits (scripted strokes):");
for (const r of results) console.log(`  drew ${r.digit} -> predicted ${r.predicted}  (${r.headline.replace(/\s+/g, " ")})  ${r.predicted === r.digit ? "ok" : "MISS"}`);
console.log(`  ${results.filter((r) => r.predicted === r.digit).length}/10 correct`);

// 2. Screenshots.
for (const { digit, file } of SHOTS) {
  await page.click("#clear");
  await page.mouse.move(5, 5); // keep the cursor off the canvas
  await drawWithMouse(digit);
  await page.screenshot({ path: file, fullPage: true });
  const r = await readout();
  console.log(`saved ${file}: drew ${digit}, app says "${r.headline.replace(/\s+/g, " ")}"`);
}

// 3. Touch: real touch events through CDP, which Chromium turns into pointer events.
const touchContext = await browser.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const touchPage = await touchContext.newPage();
await touchPage.goto(BASE);
await touchPage.waitForFunction(() => !document.getElementById("headline").textContent.includes("Loading"));
const cdp = await touchContext.newCDPSession(touchPage);
const tp = await touchPage.locator("#pad").boundingBox();
const [stroke] = strokesInBox(1, { x: tp.x + tp.width * 0.25, y: tp.y + tp.height * 0.12, w: tp.width * 0.5, h: tp.height * 0.76 });
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [stroke[0]] });
for (const p of stroke.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await touchPage.waitForTimeout(150);
const touched = await touchPage.evaluate(() => ({ top: document.querySelector("#bars li.top .digit")?.textContent ?? null, headline: document.getElementById("headline").textContent }));
console.log(`touch: drew a 1 with a finger -> predicted ${touched.top} ("${touched.headline.replace(/\s+/g, " ")}")`);
await touchPage.screenshot({ path: "docs/04-touch-phone.png", fullPage: true });
await touchContext.close();

// 4. Clear resets everything.
await page.click("#clear");
await page.waitForTimeout(100);
const cleared = await readout();
console.log(`after Clear: headline "${cleared.headline}", top bar ${cleared.top}, all bars 0%: ${cleared.rows.every((p) => p === "0%")}`);

console.log(errors.length ? `console/page errors:\n${errors.join("\n")}` : "no console or page errors");
await browser.close();
