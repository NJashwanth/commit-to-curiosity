import { describe, expect, it } from "vitest";
import {
  aggregateLanguages,
  computeStats,
  computeStreaks,
  hourHistogram,
  isValidTimeZone,
  peakIndex,
} from "../src/stats";
import { buildCalendar, buildContributions, repo, run, stampsAt } from "./fixtures";

const asCalendar = (counts: Record<string, number>) =>
  Object.entries(counts).map(([date, count]) => ({ date, count }));

describe("computeStreaks", () => {
  it("finds the longest run and breaks it on a gap", () => {
    const cal = buildCalendar(2026, { ...run("2026-02-01", 3), ...run("2026-02-10", 5), ...run("2026-03-01", 2) });
    const { longest } = computeStreaks(cal);
    expect(longest).toEqual({ length: 5, start: "2026-02-10", end: "2026-02-14" });
  });

  it("keeps the earliest streak when two are equally long", () => {
    const cal = buildCalendar(2026, { ...run("2026-05-01", 4), ...run("2026-07-01", 4) });
    expect(computeStreaks(cal).longest.start).toBe("2026-05-01");
  });

  it("treats a zero-count day as a break", () => {
    const cal = buildCalendar(2026, { ...run("2026-02-01", 3), "2026-02-04": 0, ...run("2026-02-05", 2) });
    expect(computeStreaks(cal).longest.length).toBe(3);
  });

  it("does not bridge dates that are missing from the calendar", () => {
    const cal = asCalendar({ "2026-02-01": 1, "2026-02-02": 1, "2026-02-04": 1, "2026-02-05": 1 });
    expect(computeStreaks(cal).longest.length).toBe(2);
  });

  it("handles unsorted input", () => {
    const cal = asCalendar({ "2026-02-03": 1, "2026-02-01": 1, "2026-02-02": 1 });
    expect(computeStreaks(cal).longest).toEqual({ length: 3, start: "2026-02-01", end: "2026-02-03" });
  });

  it("continues across a year boundary", () => {
    const cal = asCalendar({ "2025-12-30": 2, "2025-12-31": 1, "2026-01-01": 4, "2026-01-02": 1, "2026-01-03": 0 });
    const { longest } = computeStreaks(cal);
    expect(longest).toEqual({ length: 4, start: "2025-12-30", end: "2026-01-02" });
  });

  it("continues across Feb 29 in a leap year but not in a normal year", () => {
    const leap = buildCalendar(2024, run("2024-02-27", 4)); // 27, 28, 29, Mar 1
    expect(computeStreaks(leap).longest).toEqual({ length: 4, start: "2024-02-27", end: "2024-03-01" });
    expect(leap).toHaveLength(366);

    const normal = buildCalendar(2025, run("2025-02-27", 4)); // 27, 28, Mar 1, Mar 2
    expect(computeStreaks(normal).longest.length).toBe(4);
    expect(normal).toHaveLength(365);
  });

  it("counts a full year of activity", () => {
    const cal = buildCalendar(2024, run("2024-01-01", 366));
    const result = computeStreaks(cal);
    expect(result.longest.length).toBe(366);
    expect(result.current).toBe(366);
  });

  it("returns zeros for an all-zero or empty calendar", () => {
    for (const cal of [buildCalendar(2026), []]) {
      expect(computeStreaks(cal)).toEqual({ longest: { length: 0, start: null, end: null }, current: 0 });
    }
  });

  describe("current streak", () => {
    const cal = buildCalendar(2026, run("2026-06-01", 5)); // Jun 1 to Jun 5

    it("is the run that ends on the reference day", () => {
      expect(computeStreaks(cal, "2026-06-05").current).toBe(5);
    });

    it("survives a quiet reference day (today not over yet)", () => {
      expect(computeStreaks(cal, "2026-06-06").current).toBe(5);
    });

    it("is zero once a full day was missed", () => {
      expect(computeStreaks(cal, "2026-06-07").current).toBe(0);
    });

    it("defaults to the last calendar day", () => {
      expect(computeStreaks(cal).current).toBe(0); // calendar runs to Dec 31
      expect(computeStreaks(cal.slice(0, 156)).current).toBe(5); // trimmed to Jun 5
    });

    it("ignores a reference day before the streak ended", () => {
      expect(computeStreaks(cal, "2026-05-30").current).toBe(0);
    });
  });
});

describe("hourHistogram and peakIndex", () => {
  it("buckets UTC hours", () => {
    const counts = hourHistogram([...stampsAt(22, 3), ...stampsAt(9, 1)]);
    expect(counts[22]).toBe(3);
    expect(counts[9]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
    expect(peakIndex(counts)).toBe(22);
  });

  it("shifts hours into the requested time zone", () => {
    // 20:30 UTC is 02:00 the next day in Asia/Kolkata (UTC+5:30).
    const counts = hourHistogram(["2026-03-02T20:30:00Z"], "Asia/Kolkata");
    expect(counts[2]).toBe(1);
    // Midnight must land in bucket 0, never 24.
    expect(hourHistogram(["2026-03-02T00:10:00Z"])[0]).toBe(1);
  });

  it("skips invalid timestamps and returns null peak when empty", () => {
    const counts = hourHistogram(["not a date"]);
    expect(counts.every((c) => c === 0)).toBe(true);
    expect(peakIndex(counts)).toBeNull();
  });

  it("picks the earliest hour on a tie", () => {
    expect(peakIndex([0, 2, 0, 2])).toBe(1);
  });

  it("validates time zones", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("aggregateLanguages", () => {
  const repos = [
    repo("o/a", { TypeScript: 500, CSS: 50 }),
    repo("o/b", { TypeScript: 300, Python: 800 }),
    repo("o/c", { Go: 100, Rust: 100, Shell: 100, HTML: 5 }),
  ];

  it("sums bytes across repos and orders the top 5", () => {
    const { top, all } = aggregateLanguages(repos);
    expect(top.map((l) => l.name)).toEqual(["Python", "TypeScript", "Go", "Rust", "Shell"]);
    expect(top[1].bytes).toBe(800);
    expect(all).toHaveLength(7);
    expect(all.map((l) => l.name).slice(-2)).toEqual(["CSS", "HTML"]);
  });

  it("breaks byte ties alphabetically and reports percentages that sum to 100", () => {
    const { all } = aggregateLanguages(repos);
    expect(all.slice(2, 5).map((l) => l.name)).toEqual(["Go", "Rust", "Shell"]);
    expect(all.reduce((s, l) => s + l.percent, 0)).toBeCloseTo(100, 6);
  });

  it("handles no languages at all", () => {
    expect(aggregateLanguages([repo("o/empty", {})])).toEqual({ all: [], top: [] });
    expect(aggregateLanguages([])).toEqual({ all: [], top: [] });
  });
});

describe("computeStats", () => {
  // 2026-03-02 is a Monday. 2026-03-07 Saturday, 2026-03-08 Sunday.
  const counts = {
    "2026-01-15": 3,
    "2026-03-02": 10,
    "2026-03-03": 4,
    "2026-03-07": 6,
    "2026-03-08": 2,
    "2026-09-09": 1,
  };
  const input = {
    contributions: buildContributions(2026, counts),
    repos: [repo("octo/engine", { TypeScript: 900, CSS: 100 }, 12), repo("octo/site", { TypeScript: 100 }, 3)],
    commitTimestamps: [...stampsAt(23, 6), ...stampsAt(10, 2)],
    today: new Date("2026-12-31T00:00:00Z"),
  };

  it("finds the busiest day and month", () => {
    const s = computeStats(input);
    expect(s.busiestDay).toEqual({ date: "2026-03-02", count: 10 });
    expect(s.busiestMonth).toEqual({ month: 2, label: "March", count: 22 });
    expect(s.monthCounts[0]).toBe(3);
    expect(s.monthCounts[8]).toBe(1);
  });

  it("totals contributions and active days from the calendar", () => {
    const s = computeStats(input);
    expect(s.totalContributions).toBe(26);
    expect(s.activeDays).toBe(6);
    expect(s.longestStreak.length).toBe(2); // Mar 2 and 3, and Mar 7 and 8 tie; earliest wins
    expect(s.longestStreak.start).toBe("2026-03-02");
  });

  it("computes the weekend vs weekday split", () => {
    const s = computeStats(input);
    expect(s.weekdayCounts[1]).toBe(10); // Monday
    expect(s.weekdayCounts[6]).toBe(6); // Saturday
    expect(s.weekdayCounts[0]).toBe(2); // Sunday
    expect(s.weekendShare).toBeCloseTo((8 / 26) * 100, 6);
    expect(s.weekdayShare).toBeCloseTo((18 / 26) * 100, 6);
  });

  it("finds the peak hour from sampled commits, in the chosen zone", () => {
    expect(computeStats(input).peakHour).toBe(23);
    expect(computeStats(input).commitSample).toBe(8);
    expect(computeStats({ ...input, timeZone: "Asia/Kolkata" }).peakHour).toBe(4); // 23:00Z + 5:30
  });

  it("aggregates languages, stars and the most active repo", () => {
    const s = computeStats(input);
    expect(s.topLanguages.map((l) => l.name)).toEqual(["TypeScript", "CSS"]);
    expect(s.languageCount).toBe(2);
    expect(s.totalStars).toBe(15);
    expect(s.activeRepoCount).toBe(2);
    expect(s.mostActiveRepo?.nameWithOwner).toBe("octo/engine");
  });

  it("ignores calendar days that have not happened yet", () => {
    const s = computeStats({ ...input, today: new Date("2026-03-03T12:00:00Z") });
    expect(s.totalContributions).toBe(17);
    expect(s.calendar.at(-1)?.date).toBe("2026-03-03");
    expect(s.currentStreak).toBe(2); // Mar 2 and 3, measured at Mar 3
  });

  it("copes with a user who did nothing", () => {
    const s = computeStats({
      contributions: buildContributions(2026, {}, { activeRepos: [], totals: { commits: 0, pullRequests: 0, issues: 0, reviews: 0 } }),
      repos: [],
      commitTimestamps: [],
      today: new Date("2026-12-31T00:00:00Z"),
    });
    expect(s.totalContributions).toBe(0);
    expect(s.busiestDay).toBeNull();
    expect(s.busiestMonth).toBeNull();
    expect(s.peakHour).toBeNull();
    expect(s.weekendShare).toBe(0);
    expect(s.weekdayShare).toBe(0);
    expect(s.longestStreak.length).toBe(0);
    expect(s.mostActiveRepo).toBeNull();
    expect(s.topLanguages).toEqual([]);
  });

  it("defaults to UTC and to the real current date", () => {
    const s = computeStats({ ...input, today: undefined });
    expect(s.timeZone).toBe("UTC");
    expect(s.calendar.length).toBeGreaterThan(0);
  });
});
