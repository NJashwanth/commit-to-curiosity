import { pickPersona } from "./persona";
import type { NarrationLines, Persona, SlideId, Stats } from "./types";
import { SLIDE_IDS } from "./types";
import { formatDate, formatHour, formatNumber, pluralize, repoLabel } from "./util";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-haiku-5-5";
const MAX_LINE_LENGTH = 180;

/**
 * The only data Claude ever sees. Built from computed stats, nothing else:
 * no token, no raw commit messages, no private repo names.
 */
export function buildFacts(stats: Stats, persona: Persona) {
  return {
    user: stats.login,
    year: stats.year,
    timeZone: stats.timeZone,
    totalContributions: stats.totalContributions,
    commits: stats.totals.commits,
    pullRequests: stats.totals.pullRequests,
    issues: stats.totals.issues,
    reviews: stats.totals.reviews,
    activeDays: stats.activeDays,
    busiestDay: stats.busiestDay
      ? { date: formatDate(stats.busiestDay.date), contributions: stats.busiestDay.count }
      : null,
    busiestMonth: stats.busiestMonth
      ? { name: stats.busiestMonth.label, contributions: stats.busiestMonth.count }
      : null,
    longestStreakDays: stats.longestStreak.length,
    currentStreakDays: stats.currentStreak,
    peakCommitHour: stats.peakHour === null ? null : formatHour(stats.peakHour),
    sampledCommits: stats.commitSample,
    weekendPercent: Math.round(stats.weekendShare),
    weekdayPercent: Math.round(stats.weekdayShare),
    topLanguages: stats.topLanguages.map((l) => ({ name: l.name, percent: Math.round(l.percent) })),
    mostActiveRepo: stats.mostActiveRepo
      ? { name: repoLabel(stats.mostActiveRepo), commits: stats.mostActiveRepo.commits }
      : null,
    totalStars: stats.totalStars,
    persona: { label: persona.label, reasoning: persona.reasoning },
  };
}

export type Facts = ReturnType<typeof buildFacts>;

const SLIDE_BRIEFS: Record<SlideId, string> = {
  intro: "opening slide that greets the user and names the year",
  total: "total contributions for the year",
  heatmap: "the contribution heatmap, busiest day and busiest month",
  streak: "longest and current contribution streaks",
  hours: "the hour of day they commit the most",
  weekend: "weekend versus weekday split",
  languages: "top programming languages by bytes",
  repo: "their most active repository",
  persona: "their personality label and why they got it",
  summary: "final wrap up card",
};

export const SYSTEM_PROMPT = [
  "You write short, playful captions for a GitHub year in review slideshow, one caption per slide.",
  "Use ONLY the facts in the JSON the user provides. Never invent, estimate or calculate new numbers.",
  "Every number you write must appear in the facts exactly as given.",
  "Each caption is one sentence, friendly and a little cheeky, never mean.",
  "Do not use emojis, hashtags, em dashes or en dashes.",
  "Reply with one JSON object and nothing else. Its keys are the slide ids and its values are the captions.",
].join(" ");

export function buildPrompt(stats: Stats, persona: Persona): string {
  const facts = buildFacts(stats, persona);
  const slides = SLIDE_IDS.map((id) => `- ${id}: ${SLIDE_BRIEFS[id]}`).join("\n");
  return [
    "Facts:",
    "```json",
    JSON.stringify(facts, null, 2),
    "```",
    "",
    "Write one caption for each of these slides:",
    slides,
  ].join("\n");
}

/** Fallback captions, built from the same stats with plain templates. */
export function templateLines(stats: Stats, persona: Persona): NarrationLines {
  const n = formatNumber;
  const empty = stats.totalContributions === 0;

  const total = empty
    ? `Nothing on the board for ${stats.year} yet, so the first commit is the best one.`
    : `${n(stats.totalContributions)} contributions across ${n(stats.activeDays)} ${pluralize(stats.activeDays, "day")}. Not bad for one year.`;

  const heatmap = stats.busiestDay
    ? `${formatDate(stats.busiestDay.date)} was your loudest day with ${n(stats.busiestDay.count)} ${pluralize(stats.busiestDay.count, "contribution")}${stats.busiestMonth ? `, and ${stats.busiestMonth.label} was your busiest month` : ""}.`
    : "The heatmap is a blank canvas for now.";

  const streak =
    stats.longestStreak.length > 0
      ? `Your longest streak ran ${n(stats.longestStreak.length)} ${pluralize(stats.longestStreak.length, "day")}, and you are on ${n(stats.currentStreak)} right now.`
      : "No streak yet. Day one is whenever you say it is.";

  const hours =
    stats.peakHour === null
      ? "Not enough commit data to find your peak hour."
      : `You commit most around ${formatHour(stats.peakHour)} (${stats.timeZone}). The timestamps do not lie.`;

  const weekend = empty
    ? "No weekends to judge yet."
    : `${Math.round(stats.weekendShare)}% of your work happened on weekends and ${Math.round(stats.weekdayShare)}% on weekdays.`;

  const top = stats.topLanguages[0];
  const languages = top
    ? `${top.name} led the pack with ${Math.round(top.percent)}% of your code.`
    : "No language data to show this year.";

  const repo = stats.mostActiveRepo
    ? `${repoLabel(stats.mostActiveRepo)} got your attention with ${n(stats.mostActiveRepo.commits)} ${pluralize(stats.mostActiveRepo.commits, "commit")}.`
    : "No single repo stole the show this year.";

  return {
    intro: `${stats.year} happened. Here is what your commits had to say about it.`,
    total,
    heatmap,
    streak,
    hours,
    weekend,
    languages,
    repo,
    persona: persona.tagline,
    summary: `That was ${stats.year}. See you in ${stats.year + 1}.`,
  };
}

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
const numbersIn = (text: string) =>
  (text.match(NUMBER_RE) ?? []).map((m) => m.replace(/,/g, "").replace(/\.$/, ""));

/** Clean up one AI line, or return null if it should not be trusted. */
export function sanitizeLine(value: unknown, allowed: Set<string>): string | null {
  if (typeof value !== "string") return null;
  const line = value
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length === 0 || line.length > MAX_LINE_LENGTH) return null;
  if (numbersIn(line).some((num) => !allowed.has(num))) return null;
  return line;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface NarrateOptions {
  apiKey?: string;
  /** `--no-ai`: never call Claude even if a key is set. */
  noAi?: boolean;
  model?: string;
  fetch?: typeof fetch;
}

export interface NarrationResult {
  lines: NarrationLines;
  source: "ai" | "template";
  /** How many slides use a Claude-written line. */
  aiLineCount: number;
  /** Why template lines were used when AI was expected. */
  warning?: string;
}

export async function narrate(
  stats: Stats,
  persona: Persona = pickPersona(stats),
  options: NarrateOptions = {},
): Promise<NarrationResult> {
  const fallback = templateLines(stats, persona);
  const templateOnly = (warning?: string): NarrationResult => ({
    lines: fallback,
    source: "template",
    aiLineCount: 0,
    ...(warning ? { warning } : {}),
  });

  if (options.noAi || !options.apiKey) return templateOnly();

  const doFetch = options.fetch ?? globalThis.fetch;
  let text: string;
  try {
    const res = await doFetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildPrompt(stats, persona) }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return templateOnly(`Claude request failed (HTTP ${res.status}), using template lines.`);
    }
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    text = body.content?.find((block) => block.type === "text")?.text ?? "";
  } catch (err) {
    return templateOnly(`Claude request failed (${(err as Error).message}), using template lines.`);
  }

  const parsed = parseJsonObject(text);
  if (!parsed) return templateOnly("Claude did not return usable JSON, using template lines.");

  const allowed = new Set(numbersIn(JSON.stringify(buildFacts(stats, persona))));
  const lines = { ...fallback };
  let aiLineCount = 0;
  for (const id of SLIDE_IDS) {
    const clean = sanitizeLine(parsed[id], allowed);
    if (clean) {
      lines[id] = clean;
      aiLineCount += 1;
    }
  }
  if (aiLineCount === 0) return templateOnly("Claude's lines did not pass validation, using template lines.");
  return {
    lines,
    source: "ai",
    aiLineCount,
    ...(aiLineCount < SLIDE_IDS.length
      ? { warning: `${SLIDE_IDS.length - aiLineCount} Claude line(s) failed validation and were replaced with templates.` }
      : {}),
  };
}
