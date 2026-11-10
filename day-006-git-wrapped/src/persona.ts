import type { Persona, Stats } from "./types";
import { formatHour, formatNumber } from "./util";

/** A label counts only when its score reaches 1. The highest score wins; ties go to the earlier rule. */
interface Candidate {
  score: number;
  persona: Persona;
}

const MIN_COMMIT_SAMPLE = 20;
const MIN_CONTRIBUTIONS = 20;
const NIGHT_HOURS = [22, 23, 0, 1, 2, 3];
const EARLY_HOURS = [4, 5, 6, 7, 8];

export const THRESHOLDS = {
  streakDays: 30,
  nightShare: 35,
  earlyShare: 35,
  weekendShare: 40,
  polyglotLanguages: 6,
  polyglotTopShareMax: 60,
} as const;

function hourShare(stats: Stats, hours: number[]): number {
  if (stats.commitSample === 0) return 0;
  const inWindow = hours.reduce((sum, h) => sum + stats.hourCounts[h], 0);
  return (inWindow / stats.commitSample) * 100;
}

const round = (n: number) => Math.round(n);

export function pickPersona(stats: Stats): Persona {
  if (stats.totalContributions === 0) {
    return {
      label: "Fresh Canvas",
      tagline: "Nothing committed yet, which means everything is still possible.",
      reasoning: `No contributions were recorded in ${stats.year}.`,
    };
  }

  const candidates: Candidate[] = [];

  if (stats.longestStreak.length >= THRESHOLDS.streakDays) {
    candidates.push({
      score: stats.longestStreak.length / THRESHOLDS.streakDays,
      persona: {
        label: "Streak Machine",
        tagline: "You show up. Day after day after day.",
        reasoning: `Your longest streak was ${formatNumber(stats.longestStreak.length)} days in a row, and ${THRESHOLDS.streakDays} days is where this label starts.`,
      },
    });
  }

  if (stats.commitSample >= MIN_COMMIT_SAMPLE) {
    const night = hourShare(stats, NIGHT_HOURS);
    if (night >= THRESHOLDS.nightShare) {
      candidates.push({
        score: night / THRESHOLDS.nightShare,
        persona: {
          label: "Night Owl",
          tagline: "The best commits happen after dark.",
          reasoning: `${round(night)}% of your sampled commits landed between 10 PM and 4 AM (${stats.timeZone}).`,
        },
      });
    }
    const early = hourShare(stats, EARLY_HOURS);
    if (early >= THRESHOLDS.earlyShare) {
      candidates.push({
        score: early / THRESHOLDS.earlyShare,
        persona: {
          label: "Early Bird",
          tagline: "You push code before most people find the coffee.",
          reasoning: `${round(early)}% of your sampled commits landed between 4 AM and 9 AM (${stats.timeZone}).`,
        },
      });
    }
  }

  if (
    stats.totalContributions >= MIN_CONTRIBUTIONS &&
    stats.weekendShare >= THRESHOLDS.weekendShare
  ) {
    candidates.push({
      score: stats.weekendShare / THRESHOLDS.weekendShare,
      persona: {
        label: "Weekend Warrior",
        tagline: "Saturday and Sunday are for shipping.",
        reasoning: `${round(stats.weekendShare)}% of your contributions happened on weekends, which are only 2 of every 7 days.`,
      },
    });
  }

  const topShare = stats.topLanguages[0]?.percent ?? 0;
  if (
    stats.languageCount >= THRESHOLDS.polyglotLanguages &&
    topShare < THRESHOLDS.polyglotTopShareMax
  ) {
    candidates.push({
      score: stats.languageCount / THRESHOLDS.polyglotLanguages,
      persona: {
        label: "Polyglot",
        tagline: "One language is never enough.",
        reasoning: `You wrote in ${stats.languageCount} languages, and the top one is only ${round(topShare)}% of your code.`,
      },
    });
  }

  if (candidates.length > 0) {
    // Array.prototype.sort is stable, so equal scores keep rule order.
    return [...candidates].sort((a, b) => b.score - a.score)[0].persona;
  }

  const peak = stats.peakHour === null ? "" : ` Your commits cluster around ${formatHour(stats.peakHour)} (${stats.timeZone}).`;
  return {
    label: "Steady Builder",
    tagline: "No drama, just progress.",
    reasoning: `You contributed on ${formatNumber(stats.activeDays)} different days without leaning hard on any one pattern.${peak}`,
  };
}
