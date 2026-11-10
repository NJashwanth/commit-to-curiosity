import type {
  CalendarDay,
  ContributionData,
  LanguageShare,
  OwnedRepo,
  Stats,
} from "./types";
import { dayNumber, MONTH_NAMES, monthOf, percent, weekdayOf } from "./util";

export interface StreakResult {
  longest: { length: number; start: string | null; end: string | null };
  current: number;
}

/**
 * Longest and current streaks of consecutive days with at least one contribution.
 *
 * Streaks are decided by real date arithmetic, not array position, so a calendar that
 * is missing days, spans a year boundary or includes Feb 29 behaves correctly.
 * `asOf` is the day the "current" streak is measured at (default: the last calendar day).
 * A streak still counts as current if it ended the day before `asOf`, because that day may not be over.
 */
export function computeStreaks(calendar: CalendarDay[], asOf?: string): StreakResult {
  const days = [...calendar].sort((a, b) => a.date.localeCompare(b.date));
  const runs: { start: string; end: string; length: number }[] = [];
  let open: { start: string; end: string; length: number } | null = null;

  for (const day of days) {
    if (day.count <= 0) {
      open = null;
      continue;
    }
    if (open && dayNumber(day.date) - dayNumber(open.end) === 1) {
      open.end = day.date;
      open.length += 1;
    } else {
      open = { start: day.date, end: day.date, length: 1 };
      runs.push(open);
    }
  }

  let longest: StreakResult["longest"] = { length: 0, start: null, end: null };
  for (const run of runs) {
    if (run.length > longest.length) longest = run; // strict ">" keeps the earliest on ties
  }

  const reference = asOf ?? days.at(-1)?.date;
  const last = runs.at(-1);
  const current =
    reference && last && dayNumber(reference) - dayNumber(last.end) <= 1 && dayNumber(reference) >= dayNumber(last.end)
      ? last.length
      : 0;

  return { longest: { ...longest }, current };
}

/** Commits per local hour (24 buckets). Falls back to UTC if the zone is not recognised. */
export function hourHistogram(timestamps: string[], timeZone = "UTC"): number[] {
  const counts = new Array<number>(24).fill(0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  });
  for (const stamp of timestamps) {
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) continue;
    const hour = Number(formatter.formatToParts(date).find((p) => p.type === "hour")?.value);
    if (hour >= 0 && hour < 24) counts[hour] += 1;
  }
  return counts;
}

export function peakIndex(counts: number[]): number | null {
  let best = -1;
  let bestCount = 0;
  counts.forEach((count, i) => {
    if (count > bestCount) {
      best = i;
      bestCount = count;
    }
  });
  return best === -1 ? null : best;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Sum language bytes across repos; biggest first, ties broken by name so output is stable. */
export function aggregateLanguages(repos: OwnedRepo[]): { all: LanguageShare[]; top: LanguageShare[] } {
  const bytes = new Map<string, number>();
  for (const repo of repos) {
    for (const lang of repo.languages) {
      bytes.set(lang.name, (bytes.get(lang.name) ?? 0) + lang.bytes);
    }
  }
  const total = [...bytes.values()].reduce((a, b) => a + b, 0);
  const all = [...bytes.entries()]
    .map(([name, b]) => ({ name, bytes: b, percent: percent(b, total) }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return { all, top: all.slice(0, 5) };
}

export interface StatsInput {
  contributions: ContributionData;
  repos: OwnedRepo[];
  commitTimestamps: string[];
  timeZone?: string;
  /** Days after this date are ignored (the current year has not happened yet). Defaults to now. */
  today?: Date;
}

export function computeStats(input: StatsInput): Stats {
  const { contributions, repos, commitTimestamps } = input;
  const timeZone = input.timeZone ?? "UTC";
  const todayIso = (input.today ?? new Date()).toISOString().slice(0, 10);
  const calendar = contributions.calendar
    .filter((d) => d.date <= todayIso)
    .sort((a, b) => a.date.localeCompare(b.date));

  const totalContributions = calendar.reduce((sum, d) => sum + d.count, 0);
  const activeDays = calendar.filter((d) => d.count > 0).length;

  let busiestDay: Stats["busiestDay"] = null;
  const monthCounts = new Array<number>(12).fill(0);
  const weekdayCounts = new Array<number>(7).fill(0);
  for (const day of calendar) {
    if (day.count > 0 && (!busiestDay || day.count > busiestDay.count)) {
      busiestDay = { date: day.date, count: day.count };
    }
    monthCounts[monthOf(day.date)] += day.count;
    weekdayCounts[weekdayOf(day.date)] += day.count;
  }

  const bestMonth = peakIndex(monthCounts);
  const busiestMonth =
    bestMonth === null
      ? null
      : { month: bestMonth, label: MONTH_NAMES[bestMonth], count: monthCounts[bestMonth] };

  const weekend = weekdayCounts[0] + weekdayCounts[6];
  const weekendShare = percent(weekend, totalContributions);

  const streaks = computeStreaks(calendar);
  const hourCounts = hourHistogram(commitTimestamps, timeZone);
  const languages = aggregateLanguages(repos);

  return {
    login: contributions.login,
    name: contributions.name,
    year: contributions.year,
    timeZone,
    totals: contributions.totals,
    totalContributions,
    activeDays,
    busiestDay,
    busiestMonth,
    monthCounts,
    longestStreak: streaks.longest,
    currentStreak: streaks.current,
    weekdayCounts,
    weekendShare,
    weekdayShare: totalContributions === 0 ? 0 : 100 - weekendShare,
    hourCounts,
    commitSample: hourCounts.reduce((a, b) => a + b, 0),
    peakHour: peakIndex(hourCounts),
    topLanguages: languages.top,
    languageCount: languages.all.length,
    mostActiveRepo: contributions.activeRepos[0] ?? null,
    totalStars: repos.reduce((sum, r) => sum + r.stars, 0),
    activeRepoCount: repos.length,
    calendar,
  };
}
