import { describe, expect, it } from "vitest";
import { templateLines } from "../src/narrate";
import { pickPersona } from "../src/persona";
import { heatmapSvg, hourChartSvg, renderHtml, weekdayChartSvg } from "../src/render";
import { computeStats } from "../src/stats";
import { SLIDE_IDS } from "../src/types";
import { buildContributions, repo, run, sampleStats, stampsAt } from "./fixtures";

function render(stats = sampleStats()) {
  const persona = pickPersona(stats);
  return renderHtml({ stats, persona, lines: templateLines(stats, persona) });
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("renderHtml structure", () => {
  const html = render();

  it("outputs 8 to 10 slides, one per slide id, in order", () => {
    const sections = count(html, /<section class="slide /g);
    expect(sections).toBe(SLIDE_IDS.length);
    expect(sections).toBeGreaterThanOrEqual(8);
    expect(sections).toBeLessThanOrEqual(10);
    const ids = [...html.matchAll(/id="slide-([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([...SLIDE_IDS]);
    expect(count(html, /class="bar"/g)).toBe(SLIDE_IDS.length);
  });

  it("is a complete mobile-friendly document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('name="viewport"');
    expect(html).toContain("<title>octo&#39;s 2026 Git Wrapped</title>");
    expect(html).toContain("100dvh");
  });

  it("is self-contained: no external URLs, links, images or imported assets", () => {
    expect(html).not.toMatch(/https?:/);
    expect(html).not.toMatch(/<link\b|<img\b|@import|\bsrc=/);
    expect(count(html, /<script\b/g)).toBe(1);
    expect(count(html, /<style\b/g)).toBe(2); // main styles and the no-JS fallback
  });

  it("supports tap and arrow-key navigation", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "click", "touchend", "location.hash"]) {
      expect(html).toContain(key);
    }
  });

  it("shows the key numbers and the narration lines", () => {
    const stats = sampleStats();
    expect(html).toContain(`<p class="mega">${stats.totalContributions}</p>`);
    expect(html).toContain("April 4");
    expect(html).toContain("9 PM");
    expect(html).toContain("TypeScript");
    expect(html).toContain("octo/engine");
    expect(html).toContain(pickPersona(stats).label);
    expect(html).toContain("See you in 2027.");
    expect(html).toContain('id="replay"');
  });

  it("falls back to the login when the user has no display name", () => {
    expect(render(sampleStats({ name: null }))).toContain('<p class="who">octo</p>');
  });
});

describe("escaping", () => {
  const evil = `<img src=x onerror=alert(1)>`;

  it("escapes repo names, languages, names, logins, personas and narration", () => {
    const base = sampleStats();
    const stats = sampleStats({
      login: `<script>alert("login")</script>`,
      name: `"><svg onload=alert(2)>`,
      mostActiveRepo: { nameWithOwner: `octo/${evil}`, commits: 3, isPrivate: false },
      topLanguages: [{ name: `<b>Rust</b>`, bytes: 10, percent: 100 }],
    });
    const persona = { label: `<i>Owl</i>`, tagline: `t`, reasoning: `<u>why</u>` };
    const lines = { ...templateLines(base, persona), intro: `<script>alert(3)</script>` };
    const html = renderHtml({ stats, persona, lines });

    expect(html).not.toContain(evil);
    expect(html).toContain("octo/&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<b>Rust</b>");
    expect(html).toContain("&lt;b&gt;Rust&lt;/b&gt;");
    expect(html).not.toContain("<i>Owl</i>");
    expect(html).not.toContain("<u>why</u>");
    expect(html).toContain("&lt;script&gt;alert(3)&lt;/script&gt;");
    expect(count(html, /<script\b/g)).toBe(1); // only our own
  });

  it("never prints the name of a private repo", () => {
    const stats = sampleStats({
      mostActiveRepo: { nameWithOwner: "octo/secret-sauce", commits: 9, isPrivate: true },
    });
    const html = render(stats);
    expect(html).not.toContain("secret-sauce");
    expect(html).toContain("a private repo");
  });
});

describe("heatmap", () => {
  it("draws one cell per day of the year, leap years included", () => {
    expect(count(heatmapSvg(sampleStats()), /<rect /g)).toBe(365);
    const leap = computeStats({
      contributions: buildContributions(2024, run("2024-02-27", 4)),
      repos: [],
      commitTimestamps: [],
      today: new Date("2024-12-31T00:00:00Z"),
    });
    expect(count(heatmapSvg(leap), /<rect /g)).toBe(366);
    expect(heatmapSvg(leap)).toContain("February 29: 1 contribution");
  });

  it("scales intensity levels to the busiest day and marks future days", () => {
    const stats = computeStats({
      contributions: buildContributions(2026, { "2026-01-01": 1, "2026-01-02": 10, "2026-01-03": 4 }),
      repos: [],
      commitTimestamps: [],
      today: new Date("2026-01-05T00:00:00Z"),
    });
    const svg = heatmapSvg(stats);
    expect(svg).toContain('class="c l4"'); // the 10
    expect(svg).toContain('class="c l1"'); // the 1
    expect(svg).toContain('class="c l2"'); // the 4 (ceil(4*4/10) = 2)
    expect(svg).toContain('class="c l0"'); // Jan 4 and 5, quiet but known
    expect(svg).toContain("fut"); // after "today"
  });

  it("labels the months", () => {
    const svg = heatmapSvg(sampleStats());
    for (const m of ["Jan", "Jun", "Dec"]) expect(svg).toContain(`>${m}</text>`);
    expect(svg).toContain('role="img"');
  });
});

describe("hour chart", () => {
  it("draws 24 bars and highlights the peak hour", () => {
    const svg = hourChartSvg(sampleStats());
    expect(count(svg, /class="bar-h/g)).toBe(24);
    expect(count(svg, /class="bar-h peak"/g)).toBe(1);
    expect(svg).toContain("9 PM: 12 commits");
    expect(svg).toContain("viewBox");
  });

  it("shows a message instead of a chart when there are no timestamps", () => {
    const stats = sampleStats({ hourCounts: new Array(24).fill(0), peakHour: null, commitSample: 0 });
    expect(hourChartSvg(stats)).toContain("No commit timestamps");
    expect(render(stats)).toContain('<p class="mega">?</p>');
  });

  it("charts weekdays with weekends highlighted", () => {
    const svg = weekdayChartSvg(sampleStats());
    expect(count(svg, /class="bar-h/g)).toBe(7);
    expect(count(svg, /class="bar-h peak"/g)).toBe(2);
    expect(weekdayChartSvg(sampleStats({ weekdayCounts: new Array(7).fill(0) }))).toContain("No contributions");
  });
});

describe("a year with nothing in it", () => {
  const stats = computeStats({
    contributions: buildContributions(2026, {}, { activeRepos: [] }),
    repos: [],
    commitTimestamps: [],
    today: new Date("2026-12-31T00:00:00Z"),
  });
  const html = render(stats);

  it("still renders every slide without NaN or undefined", () => {
    expect(count(html, /<section class="slide /g)).toBe(SLIDE_IDS.length);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
    expect(html).toContain("Fresh Canvas");
    expect(html).toContain("No standout repo");
    expect(html).toContain("No language data this year.");
    expect(html).toContain("None yet");
    expect(html).toContain("No streak yet");
  });
});

describe("singular wording and language overflow", () => {
  it("uses singular forms and shows how many languages are hidden", () => {
    const stats = computeStats({
      contributions: buildContributions(2026, { "2026-05-05": 1 }, {
        totals: { commits: 1, pullRequests: 1, issues: 1, reviews: 1 },
        activeRepos: [{ nameWithOwner: "o/r", commits: 1, isPrivate: false }],
      }),
      repos: [repo("o/r", { A: 7, B: 6, C: 5, D: 4, E: 3, F: 2, G: 1 }, 1)],
      commitTimestamps: stampsAt(3, 1),
      today: new Date("2026-12-31T00:00:00Z"),
    });
    const html = render(stats);
    expect(html).toContain("1</b> commit<");
    expect(html).toContain("1</b> pull request<");
    expect(html).toContain("1</b> issue<");
    expect(html).toContain("1</b> review<");
    expect(html).toContain("1 star across 1 repo you pushed to");
    expect(html).toContain("plus 2 more");
    expect(html).toContain("1 sampled commit,");
  });
});
