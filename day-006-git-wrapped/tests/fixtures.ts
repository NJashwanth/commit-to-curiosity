import type { CalendarDay, ContributionData, OwnedRepo } from "../src/types";
import { dayNumber, isoFromDayNumber, isLeapYear } from "../src/util";

/** A full-year calendar of zeros with the given dates set to the given counts. */
export function buildCalendar(year: number, counts: Record<string, number> = {}): CalendarDay[] {
  const start = dayNumber(`${year}-01-01`);
  const length = isLeapYear(year) ? 366 : 365;
  return Array.from({ length }, (_, i) => {
    const date = isoFromDayNumber(start + i);
    return { date, count: counts[date] ?? 0 };
  });
}

/** `count` consecutive days starting at `start`, each with `perDay` contributions. */
export function run(start: string, count: number, perDay = 1): Record<string, number> {
  const first = dayNumber(start);
  const out: Record<string, number> = {};
  for (let i = 0; i < count; i++) out[isoFromDayNumber(first + i)] = perDay;
  return out;
}

export function buildContributions(
  year: number,
  counts: Record<string, number> = {},
  overrides: Partial<ContributionData> = {},
): ContributionData {
  const calendar = buildCalendar(year, counts);
  return {
    login: "octo",
    name: "Octo Cat",
    year,
    totals: { commits: 40, pullRequests: 6, issues: 3, reviews: 5 },
    calendarTotal: calendar.reduce((s, d) => s + d.count, 0),
    calendar,
    activeRepos: [
      { nameWithOwner: "octo/engine", commits: 25, isPrivate: false },
      { nameWithOwner: "octo/site", commits: 10, isPrivate: false },
    ],
    ...overrides,
  };
}

export function repo(
  name: string,
  languages: Record<string, number>,
  stars = 0,
  isPrivate = false,
): OwnedRepo {
  return {
    nameWithOwner: name,
    stars,
    isPrivate,
    pushedAt: "2026-06-01T00:00:00Z",
    primaryLanguage: Object.keys(languages)[0] ?? null,
    languages: Object.entries(languages).map(([n, bytes]) => ({ name: n, bytes })),
  };
}

/** n timestamps at the given UTC hour, on dates spread across the year (Mon to Fri by default). */
export function stampsAt(hour: number, n: number, date = "2026-03-02"): string[] {
  const hh = String(hour).padStart(2, "0");
  return Array.from({ length: n }, (_, i) => `${date}T${hh}:${String(i % 60).padStart(2, "0")}:00Z`);
}

import { computeStats } from "../src/stats";
import type { Stats } from "../src/types";

/** A busy, believable year: weekday-heavy, late-night commits, three languages. */
export function sampleStats(overrides: Partial<Stats> = {}): Stats {
  const counts = {
    ...run("2026-02-02", 5, 4), // Mon to Fri
    ...run("2026-03-09", 3, 2),
    "2026-04-04": 12, // a Saturday, the busiest day
    "2026-04-05": 2,
  };
  const stats = computeStats({
    contributions: buildContributions(2026, counts, {
      totals: { commits: 1234, pullRequests: 56, issues: 7, reviews: 89 },
    }),
    repos: [
      repo("octo/engine", { TypeScript: 6000, CSS: 500 }, 40),
      repo("octo/site", { TypeScript: 1000, HTML: 900, Python: 100 }, 2),
    ],
    commitTimestamps: [...stampsAt(21, 12), ...stampsAt(10, 4), ...stampsAt(15, 4)],
    today: new Date("2026-12-31T00:00:00Z"),
  });
  return { ...stats, ...overrides };
}
