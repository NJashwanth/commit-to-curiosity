/** One cell of the contribution calendar. `date` is YYYY-MM-DD (UTC, as GitHub reports it). */
export interface CalendarDay {
  date: string;
  count: number;
}

export interface ContributionTotals {
  commits: number;
  pullRequests: number;
  issues: number;
  reviews: number;
}

export interface RepoActivity {
  nameWithOwner: string;
  commits: number;
  isPrivate: boolean;
}

/** Everything GraphQL `contributionsCollection` gives us for one user and year. */
export interface ContributionData {
  login: string;
  name: string | null;
  year: number;
  totals: ContributionTotals;
  /** Total as reported by GitHub's calendar (includes restricted contributions). */
  calendarTotal: number;
  calendar: CalendarDay[];
  /** Most active repos by commit count, descending (GitHub caps this at 10). */
  activeRepos: RepoActivity[];
}

export interface LanguageBytes {
  name: string;
  bytes: number;
}

export interface OwnedRepo {
  nameWithOwner: string;
  stars: number;
  isPrivate: boolean;
  pushedAt: string;
  primaryLanguage: string | null;
  languages: LanguageBytes[];
}

export interface LanguageShare extends LanguageBytes {
  /** Share of all counted bytes, 0 to 100. */
  percent: number;
}

/** Everything the stats engine computes. Plain data only, so it can be fed to the narrator and the renderer. */
export interface Stats {
  login: string;
  name: string | null;
  year: number;
  /** IANA time zone used for hour-of-day bucketing. */
  timeZone: string;
  totals: ContributionTotals;
  totalContributions: number;
  activeDays: number;
  busiestDay: { date: string; count: number } | null;
  busiestMonth: { month: number; label: string; count: number } | null;
  monthCounts: number[];
  longestStreak: { length: number; start: string | null; end: string | null };
  currentStreak: number;
  /** Contributions by weekday, index 0 = Sunday. */
  weekdayCounts: number[];
  weekendShare: number;
  weekdayShare: number;
  /** Commits by local hour, 24 buckets, from the sampled commit timestamps. */
  hourCounts: number[];
  commitSample: number;
  peakHour: number | null;
  topLanguages: LanguageShare[];
  languageCount: number;
  mostActiveRepo: RepoActivity | null;
  totalStars: number;
  /** Owned, non-fork repos pushed to during the year. */
  activeRepoCount: number;
  calendar: CalendarDay[];
}

export interface Persona {
  label: string;
  tagline: string;
  /** Why this label was picked, written from the numbers. */
  reasoning: string;
}

/** One id per slide, in display order. */
export const SLIDE_IDS = [
  "intro",
  "total",
  "heatmap",
  "streak",
  "hours",
  "weekend",
  "languages",
  "repo",
  "persona",
  "summary",
] as const;

export type SlideId = (typeof SLIDE_IDS)[number];
export type NarrationLines = Record<SlideId, string>;
