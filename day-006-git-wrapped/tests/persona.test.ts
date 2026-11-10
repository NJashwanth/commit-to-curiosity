import { describe, expect, it } from "vitest";
import { pickPersona, THRESHOLDS } from "../src/persona";
import { computeStats } from "../src/stats";
import { buildContributions, repo, run, stampsAt } from "./fixtures";

const TODAY = new Date("2026-12-31T00:00:00Z");

/** Build stats from a few knobs. Weekday contributions spread over 5 separate weeks by default. */
function statsFor(opts: {
  counts?: Record<string, number>;
  hours?: Record<number, number>;
  languages?: Record<string, number>;
}) {
  const hours = opts.hours ?? { 14: 30 };
  return computeStats({
    contributions: buildContributions(2026, opts.counts ?? { ...run("2026-03-02", 1, 30) }),
    repos: [repo("octo/a", opts.languages ?? { TypeScript: 100 })],
    commitTimestamps: Object.entries(hours).flatMap(([h, n]) => stampsAt(Number(h), n)),
    today: TODAY,
  });
}

// Mondays, so nothing here counts as a weekend and no streak forms.
const weekdayOnly = { "2026-03-02": 10, "2026-03-09": 10, "2026-03-16": 10 };

describe("pickPersona", () => {
  it("labels a late-night committer a Night Owl and explains why", () => {
    const p = pickPersona(statsFor({ counts: weekdayOnly, hours: { 23: 20, 1: 10, 14: 10 } }));
    expect(p.label).toBe("Night Owl");
    expect(p.reasoning).toContain("75%");
    expect(p.reasoning).toContain("UTC");
  });

  it("labels a dawn committer an Early Bird", () => {
    const p = pickPersona(statsFor({ counts: weekdayOnly, hours: { 6: 25, 15: 15 } }));
    expect(p.label).toBe("Early Bird");
    expect(p.reasoning).toContain("63%");
  });

  it("labels a weekend-heavy year a Weekend Warrior", () => {
    // 2026-03-07 and 03-14 are Saturdays, 03-08 and 03-15 Sundays, 03-02 a Monday.
    const counts = { "2026-03-07": 10, "2026-03-14": 10, "2026-03-15": 5, "2026-03-02": 5 };
    const p = pickPersona(statsFor({ counts, hours: { 14: 30 } }));
    expect(p.label).toBe("Weekend Warrior");
    expect(p.reasoning).toContain("83%");
  });

  it("labels a 40+ day run a Streak Machine", () => {
    const p = pickPersona(statsFor({ counts: run("2026-02-02", 45), hours: { 14: 30 } }));
    expect(p.label).toBe("Streak Machine");
    expect(p.reasoning).toContain("45 days");
  });

  it("labels a wide language spread a Polyglot", () => {
    const languages = { TypeScript: 30, Python: 25, Go: 20, Rust: 10, Ruby: 8, Dart: 7 };
    const p = pickPersona(statsFor({ counts: weekdayOnly, languages }));
    expect(p.label).toBe("Polyglot");
    expect(p.reasoning).toContain("6 languages");
  });

  it("does not call it Polyglot when one language dominates", () => {
    const languages = { TypeScript: 900, Python: 20, Go: 20, Rust: 20, Ruby: 20, Dart: 20 };
    expect(pickPersona(statsFor({ counts: weekdayOnly, languages })).label).toBe("Steady Builder");
  });

  it("picks the strongest signal when several rules match", () => {
    // Night share is 100% (score 2.9), weekend share 50% (score 1.25).
    const counts = { "2026-03-07": 10, "2026-03-02": 10 };
    const p = pickPersona(statsFor({ counts, hours: { 0: 30 } }));
    expect(p.label).toBe("Night Owl");
  });

  it("breaks exact ties in rule order (Streak Machine before Night Owl)", () => {
    // Streak 30 days -> score 1.0; night share 35% -> score 1.0.
    const counts = run("2026-02-02", THRESHOLDS.streakDays);
    const hours = { 23: 7, 14: 13 }; // 7 of 20 = 35%
    expect(pickPersona(statsFor({ counts, hours })).label).toBe("Streak Machine");
  });

  it("falls back to Steady Builder and mentions the peak hour", () => {
    const p = pickPersona(statsFor({ counts: weekdayOnly, hours: { 14: 30 } }));
    expect(p.label).toBe("Steady Builder");
    expect(p.reasoning).toContain("2 PM");
  });

  it("does not trust time-of-day rules on a tiny commit sample", () => {
    const p = pickPersona(statsFor({ counts: weekdayOnly, hours: { 23: 5 } }));
    expect(p.label).toBe("Steady Builder");
  });

  it("does not hand out Weekend Warrior for a handful of contributions", () => {
    const p = pickPersona(statsFor({ counts: { "2026-03-07": 3 }, hours: {} }));
    expect(p.label).toBe("Steady Builder");
    expect(p.reasoning).not.toContain("cluster");
  });

  it("gives a zero-activity user Fresh Canvas", () => {
    const p = pickPersona(statsFor({ counts: {}, hours: {}, languages: {} }));
    expect(p.label).toBe("Fresh Canvas");
    expect(p.reasoning).toContain("2026");
  });
});
