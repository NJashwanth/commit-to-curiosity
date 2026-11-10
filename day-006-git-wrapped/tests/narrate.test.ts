import { describe, expect, it, vi } from "vitest";
import {
  buildFacts,
  buildPrompt,
  narrate,
  sanitizeLine,
  SYSTEM_PROMPT,
  templateLines,
} from "../src/narrate";
import { pickPersona } from "../src/persona";
import { SLIDE_IDS } from "../src/types";
import { sampleStats } from "./fixtures";

const stats = sampleStats();
const persona = pickPersona(stats);

function claudeReply(lines: Record<string, unknown>, wrap = (s: string) => s) {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: wrap(JSON.stringify(lines)) }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mockFetch(respond: () => Response | Promise<Response>) {
  return vi.fn(async () => respond()) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const goodLines = () => ({
  intro: "2026 was a big one for octo.",
  total: "A solid 999 commits this year.", // 999 is not a fact: must be rejected
  heatmap: "April 4 was your loudest day.",
  streak: "Five days straight, nicely done.",
  hours: "You peak around 9 PM, night shift energy.",
  weekend: "Mostly weekdays, you clock in.",
  languages: "TypeScript carried the year.",
  repo: "octo/engine was the main character.",
  persona: "Night shift suits you.",
  summary: "Onwards to the next one.",
});

describe("buildFacts and buildPrompt", () => {
  it("builds facts only from computed stats", () => {
    const facts = buildFacts(stats, persona);
    expect(facts).toMatchObject({
      user: "octo",
      year: 2026,
      totalContributions: stats.totalContributions,
      commits: 1234,
      pullRequests: 56,
      issues: 7,
      reviews: 89,
      busiestDay: { date: "April 4", contributions: 12 },
      longestStreakDays: 5,
      peakCommitHour: "9 PM",
      topLanguages: [
        { name: "TypeScript", percent: 82 },
        { name: "HTML", percent: 11 },
        { name: "CSS", percent: 6 },
        { name: "Python", percent: 1 },
      ],
      mostActiveRepo: { name: "octo/engine", commits: 25 },
      persona: { label: persona.label },
    });
  });

  it("puts exactly the facts in the prompt and no stray numbers anywhere else", () => {
    const prompt = buildPrompt(stats, persona);
    const json = prompt.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(JSON.parse(json!)).toEqual(buildFacts(stats, persona));

    const outsideFacts = prompt.replace(/```json[\s\S]*?```/, "");
    expect(outsideFacts).not.toMatch(/\d/);
    expect(SYSTEM_PROMPT).not.toMatch(/\d/);
    for (const id of SLIDE_IDS) expect(prompt).toContain(`- ${id}:`);
  });

  it("never includes the calendar, tokens or raw timestamps", () => {
    const prompt = buildPrompt(stats, persona);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(prompt).not.toContain("calendar");
    expect(prompt).not.toContain("ghp_");
  });

  it("hides private repo names", () => {
    const priv = sampleStats({
      mostActiveRepo: { nameWithOwner: "octo/secret-sauce", commits: 9, isPrivate: true },
    });
    const prompt = buildPrompt(priv, persona);
    expect(prompt).not.toContain("secret-sauce");
    expect(prompt).toContain("a private repo");
    expect(JSON.stringify(templateLines(priv, persona))).not.toContain("secret-sauce");
  });

  it("handles stats with nothing to report", () => {
    const empty = sampleStats({
      busiestDay: null,
      busiestMonth: null,
      peakHour: null,
      mostActiveRepo: null,
    });
    const facts = buildFacts(empty, persona);
    expect(facts.busiestDay).toBeNull();
    expect(facts.busiestMonth).toBeNull();
    expect(facts.peakCommitHour).toBeNull();
    expect(facts.mostActiveRepo).toBeNull();
  });
});

describe("templateLines", () => {
  it("has a line for every slide, built from the stats", () => {
    const lines = templateLines(stats, persona);
    expect(Object.keys(lines)).toEqual([...SLIDE_IDS]);
    expect(lines.total).toContain(String(stats.totalContributions));
    expect(lines.heatmap).toContain("April 4");
    expect(lines.hours).toContain("9 PM");
    expect(lines.languages).toContain("TypeScript");
    expect(lines.repo).toContain("octo/engine");
    expect(lines.persona).toBe(persona.tagline);
    expect(lines.summary).toContain("2027");
  });

  it("does not use dashes as punctuation", () => {
    for (const line of Object.values(templateLines(stats, persona))) {
      expect(line).not.toMatch(/[–—]/);
    }
  });

  it("covers the empty year", () => {
    const empty = sampleStats({
      totalContributions: 0,
      activeDays: 0,
      busiestDay: null,
      busiestMonth: null,
      longestStreak: { length: 0, start: null, end: null },
      peakHour: null,
      topLanguages: [],
      mostActiveRepo: null,
    });
    const lines = templateLines(empty, pickPersona(empty));
    for (const id of SLIDE_IDS) expect(lines[id].length).toBeGreaterThan(0);
    expect(lines.total).toContain("2026");
    expect(lines.streak).toContain("No streak");
  });

  it("handles a busiest day with no busiest month and singular words", () => {
    const odd = sampleStats({
      activeDays: 1,
      totalContributions: 1,
      busiestDay: { date: "2026-01-05", count: 1 },
      busiestMonth: null,
      longestStreak: { length: 1, start: "2026-01-05", end: "2026-01-05" },
      mostActiveRepo: { nameWithOwner: "o/r", commits: 1, isPrivate: false },
    });
    const lines = templateLines(odd, persona);
    expect(lines.heatmap).toBe("January 5 was your loudest day with 1 contribution.");
    expect(lines.streak).toContain("1 day,");
    expect(lines.repo).toContain("1 commit.");
  });
});

describe("sanitizeLine", () => {
  const allowed = new Set(["2026", "12"]);

  it("accepts lines whose numbers are all in the facts", () => {
    expect(sanitizeLine("12 on the loudest day of 2026.", allowed)).toBe("12 on the loudest day of 2026.");
    expect(sanitizeLine("No numbers here", allowed)).toBe("No numbers here");
  });

  it("rejects made-up numbers", () => {
    expect(sanitizeLine("You shipped 13 things", allowed)).toBeNull();
    expect(sanitizeLine("About 12.5 per day", allowed)).toBeNull();
  });

  it("normalises thousands separators before checking", () => {
    expect(sanitizeLine("That is 1,234 commits", new Set(["1234"]))).toBe("That is 1,234 commits");
  });

  it("replaces dashes, collapses whitespace and rejects non-strings and bad lengths", () => {
    expect(sanitizeLine("Big year — huge\n\nwins", allowed)).toBe("Big year, huge wins");
    expect(sanitizeLine(42, allowed)).toBeNull();
    expect(sanitizeLine("   ", allowed)).toBeNull();
    expect(sanitizeLine("x".repeat(500), allowed)).toBeNull();
  });
});

describe("narrate", () => {
  const template = templateLines(stats, persona);

  it("uses templates and makes no request when the key is missing", async () => {
    const fetch = mockFetch(() => claudeReply(goodLines()));
    const result = await narrate(stats, persona, { fetch });
    expect(result).toEqual({ lines: template, source: "template", aiLineCount: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses templates and makes no request with --no-ai even when a key is set", async () => {
    const fetch = mockFetch(() => claudeReply(goodLines()));
    const result = await narrate(stats, persona, { apiKey: "sk-test", noAi: true, fetch });
    expect(result.source).toBe("template");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls the Anthropic API with the key, model and facts-only prompt", async () => {
    const fetch = mockFetch(() => claudeReply(goodLines()));
    await narrate(stats, persona, { apiKey: "sk-test", model: "claude-test-model", fetch });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-test-model");
    expect(body.system).toBe(SYSTEM_PROMPT);
    expect(body.messages).toEqual([{ role: "user", content: buildPrompt(stats, persona) }]);
    expect(JSON.stringify(body)).not.toContain("sk-test");
  });

  it("keeps valid AI lines and falls back per slide for invalid ones", async () => {
    const fetch = mockFetch(() => claudeReply({ ...goodLines(), weekend: 7, repo: "" }));
    const result = await narrate(stats, persona, { apiKey: "k", fetch });
    expect(result.source).toBe("ai");
    expect(result.lines.intro).toBe("2026 was a big one for octo.");
    expect(result.lines.total).toBe(template.total); // made-up 999
    expect(result.lines.weekend).toBe(template.weekend); // not a string
    expect(result.lines.repo).toBe(template.repo); // empty
    expect(result.aiLineCount).toBe(7);
    expect(result.warning).toContain("3 Claude line(s)");
  });

  it("accepts JSON wrapped in a code fence", async () => {
    const fetch = mockFetch(() => claudeReply(goodLines(), (s) => "```json\n" + s + "\n```"));
    const result = await narrate(stats, persona, { apiKey: "k", fetch });
    expect(result.lines.summary).toBe("Onwards to the next one.");
  });

  it("reports no warning when every line is valid", async () => {
    const all = Object.fromEntries(SLIDE_IDS.map((id) => [id, "A friendly line."]));
    const result = await narrate(stats, persona, { apiKey: "k", fetch: mockFetch(() => claudeReply(all)) });
    expect(result.aiLineCount).toBe(SLIDE_IDS.length);
    expect(result.warning).toBeUndefined();
  });

  it("falls back to templates when Claude returns an HTTP error", async () => {
    const fetch = mockFetch(() => new Response("{}", { status: 529 }));
    const result = await narrate(stats, persona, { apiKey: "k", fetch });
    expect(result.lines).toEqual(template);
    expect(result.source).toBe("template");
    expect(result.warning).toContain("529");
  });

  it("falls back to templates when the request throws", async () => {
    const fetch = mockFetch(() => {
      throw new Error("socket hang up");
    });
    const result = await narrate(stats, persona, { apiKey: "k", fetch });
    expect(result.lines).toEqual(template);
    expect(result.warning).toContain("socket hang up");
  });

  it("falls back when the reply is not JSON, has no text, or every line is rejected", async () => {
    const prose = mockFetch(() => new Response(JSON.stringify({ content: [{ type: "text", text: "Sure! Here you go." }] })));
    expect((await narrate(stats, persona, { apiKey: "k", fetch: prose })).warning).toContain("usable JSON");

    const noText = mockFetch(() => new Response(JSON.stringify({ content: [] })));
    expect((await narrate(stats, persona, { apiKey: "k", fetch: noText })).lines).toEqual(template);

    const noContent = mockFetch(() => new Response(JSON.stringify({})));
    expect((await narrate(stats, persona, { apiKey: "k", fetch: noContent })).source).toBe("template");

    const array = mockFetch(() => new Response(JSON.stringify({ content: [{ type: "text", text: "[1, 2]" }] })));
    expect((await narrate(stats, persona, { apiKey: "k", fetch: array })).source).toBe("template");

    const broken = mockFetch(() => new Response(JSON.stringify({ content: [{ type: "text", text: "{not json}" }] })));
    expect((await narrate(stats, persona, { apiKey: "k", fetch: broken })).source).toBe("template");

    const allBad = mockFetch(() => claudeReply(Object.fromEntries(SLIDE_IDS.map((id) => [id, "You did 999999 things"]))));
    const result = await narrate(stats, persona, { apiKey: "k", fetch: allBad });
    expect(result.source).toBe("template");
    expect(result.warning).toContain("validation");
  });

  it("computes the persona itself when none is passed", async () => {
    const result = await narrate(stats);
    expect(result.lines.persona).toBe(persona.tagline);
  });
});
