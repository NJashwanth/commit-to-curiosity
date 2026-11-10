import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCliArgs, parseDotEnv, run, secret, UsageError, type CliDeps } from "../src/cli";

const NOW = new Date("2026-11-10T12:00:00Z");

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Net {
  contributions?: (variables: Record<string, string>) => Response;
  repos?: () => Response;
  commits?: () => Response;
  claude?: () => Response;
}

/** A fake of everything the CLI talks to: GitHub GraphQL, GitHub REST and the Anthropic API. */
function fakeNetwork(net: Net = {}) {
  const calls = { anthropic: 0, graphql: [] as Record<string, string>[], rest: [] as string[] };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.anthropic.com")) {
      calls.anthropic += 1;
      return net.claude ? net.claude() : json({ content: [{ type: "text", text: JSON.stringify({ intro: "Claude says hi." }) }] });
    }
    if (url.endsWith("/graphql")) {
      const body = JSON.parse(init!.body as string) as { query: string; variables: Record<string, string> };
      if (body.query.includes("contributionsCollection")) {
        calls.graphql.push(body.variables);
        return net.contributions ? net.contributions(body.variables) : json(contributions(Number(body.variables.from.slice(0, 4))));
      }
      return net.repos ? net.repos() : json(repos());
    }
    calls.rest.push(url);
    return net.commits ? net.commits() : json([{ commit: { author: { date: "2026-03-02T23:15:00Z" } } }]);
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, calls };
}

function contributions(year: number, active = true) {
  const days = active
    ? [
        { date: `${year}-03-02`, contributionCount: 5 },
        { date: `${year}-03-03`, contributionCount: 3 },
      ]
    : [{ date: `${year}-03-02`, contributionCount: 0 }];
  return {
    data: {
      user: {
        login: "NJashwanth",
        name: "Jashwanth Neela",
        contributionsCollection: {
          totalCommitContributions: active ? 6 : 0,
          totalPullRequestContributions: 1,
          totalIssueContributions: 0,
          totalPullRequestReviewContributions: 1,
          contributionCalendar: { totalContributions: active ? 8 : 0, weeks: [{ contributionDays: days }] },
          commitContributionsByRepository: active
            ? [{ repository: { nameWithOwner: "NJashwanth/commit-to-curiosity", isPrivate: false }, contributions: { totalCount: 6 } }]
            : [],
        },
      },
    },
  };
}

function repos() {
  return {
    data: {
      user: {
        repositories: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              nameWithOwner: "NJashwanth/commit-to-curiosity",
              stargazerCount: 2,
              isPrivate: false,
              pushedAt: "2026-06-01T00:00:00Z",
              primaryLanguage: { name: "TypeScript" },
              languages: { edges: [{ size: 900, node: { name: "TypeScript" } }, { size: 100, node: { name: "Python" } }] },
            },
          ],
        },
      },
    },
  };
}

function harness(env: Record<string, string | undefined>, net: Net = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const network = fakeNetwork(net);
  const deps: CliDeps = {
    env,
    fetch: network.fetchMock,
    now: () => NOW,
    stdout: (m) => out.push(m),
    stderr: (m) => err.push(m),
    writeFile: async (path, data) => void files.set(path, data),
  };
  return { deps, out, err, files, ...network };
}

describe("parseCliArgs", () => {
  it("applies defaults: current year, UTC, AI on, derived output name", () => {
    expect(parseCliArgs(["NJashwanth"], NOW)).toEqual({
      login: "NJashwanth",
      year: 2026,
      out: "git-wrapped-NJashwanth-2026.html",
      noAi: false,
      timeZone: "UTC",
      help: false,
    });
  });

  it("reads --year, --out, --no-ai and --tz in any order", () => {
    const args = parseCliArgs(["--out", "wrapped.html", "NJashwanth", "--no-ai", "--year", "2025", "--tz", "Asia/Kolkata"], NOW);
    expect(args).toMatchObject({ login: "NJashwanth", year: 2025, out: "wrapped.html", noAi: true, timeZone: "Asia/Kolkata" });
    expect(parseCliArgs(["NJashwanth", "--year=2024", "--out=a/b.html"], NOW)).toMatchObject({ year: 2024, out: "a/b.html" });
  });

  it("derives the output name from --year", () => {
    expect(parseCliArgs(["octo", "--year", "2023"], NOW).out).toBe("git-wrapped-octo-2023.html");
  });

  it("accepts a leading @ and recognises --help", () => {
    expect(parseCliArgs(["@octo"], NOW).login).toBe("octo");
    expect(parseCliArgs(["--help"], NOW).help).toBe(true);
    expect(parseCliArgs(["-h"], NOW).help).toBe(true);
  });

  it.each([
    [[], "Missing GitHub username"],
    [["a", "b"], "Expected one username"],
    [["bad_name"], "not a valid GitHub username"],
    [["-bad"], "Unknown option"],
    [["has space"], "not a valid GitHub username"],
    [["x".repeat(40)], "not a valid GitHub username"],
    [["octo", "--year", "abc"], "4 digit year"],
    [["octo", "--year", "2007"], "between 2008 and 2026"],
    [["octo", "--year", "2027"], "between 2008 and 2026"],
    [["octo", "--tz", "Mars/Base"], "Unknown time zone"],
    [["octo", "--nope"], "nope"],
    [["octo", "--year"], "year"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv, NOW)).toThrow(UsageError);
    expect(() => parseCliArgs(argv, NOW)).toThrow(message);
  });

  it("defaults to the real current date when none is passed", () => {
    expect(parseCliArgs(["octo"]).year).toBe(new Date().getUTCFullYear());
  });
});

describe(".env helpers", () => {
  it("parses KEY=VALUE lines, comments, quotes and export", () => {
    const parsed = parseDotEnv(`# comment\n\nGITHUB_TOKEN=abc\nexport A="quoted value"\nB='single'\nC=with=equals\nbroken line\n=novalue\r\nD=last`);
    expect(parsed).toEqual({ GITHUB_TOKEN: "abc", A: "quoted value", B: "single", C: "with=equals", D: "last" });
  });

  it("treats blanks and .env.example placeholders as unset", () => {
    expect(secret(undefined)).toBeUndefined();
    expect(secret("  ")).toBeUndefined();
    expect(secret("your-github-token")).toBeUndefined();
    expect(secret("your-key-here")).toBeUndefined();
    expect(secret(" ghp_real ")).toBe("ghp_real");
  });
});

describe("run: success", () => {
  it("writes the HTML to --out and prints a summary", async () => {
    const h = harness({ GITHUB_TOKEN: "ghp_x" });
    const code = await run(["NJashwanth", "--out", "wrapped.html"], h.deps);
    expect(code).toBe(0);
    const html = h.files.get("wrapped.html")!;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("NJashwanth");
    expect(h.out.join("\n")).toContain("Wrote wrapped.html");
    expect(h.out.join("\n")).toContain("template lines");
    expect(h.err.join("\n")).toContain("Fetching contributions");
  });

  it("uses the default file name when --out is omitted", async () => {
    const h = harness({ GITHUB_TOKEN: "ghp_x" });
    await run(["NJashwanth"], h.deps);
    expect([...h.files.keys()]).toEqual(["git-wrapped-NJashwanth-2026.html"]);
  });

  it("passes --year through to GitHub and into the page", async () => {
    const h = harness({ GITHUB_TOKEN: "ghp_x" });
    expect(await run(["NJashwanth", "--year", "2025", "--out", "o.html"], h.deps)).toBe(0);
    expect(h.calls.graphql[0]).toMatchObject({ from: "2025-01-01T00:00:00Z", to: "2025-12-31T23:59:59Z" });
    expect(h.files.get("o.html")).toContain("2025");
  });

  it("passes --tz through to the hour chart", async () => {
    const h = harness({ GITHUB_TOKEN: "ghp_x" });
    await run(["NJashwanth", "--tz", "Asia/Kolkata", "--out", "o.html"], h.deps);
    expect(h.files.get("o.html")).toContain("hours in Asia/Kolkata");
    expect(h.files.get("o.html")).toContain("4 AM"); // 23:15Z is 04:45 in Kolkata
  });

  it("writes a real file, creating nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-wrapped-"));
    try {
      const h = harness({ GITHUB_TOKEN: "ghp_x" });
      const { writeFile, mkdir } = await import("node:fs/promises");
      h.deps.writeFile = async (p, d) => {
        await mkdir(join(p, ".."), { recursive: true });
        await writeFile(p, d, "utf8");
      };
      const target = join(dir, "nested", "w.html");
      expect(await run(["NJashwanth", "--out", target], h.deps)).toBe(0);
      expect(await readFile(target, "utf8")).toContain("</html>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shows help with exit code 0", async () => {
    const h = harness({});
    expect(await run(["--help"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("--no-ai");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("run: narration flags", () => {
  const env = { GITHUB_TOKEN: "ghp_x", ANTHROPIC_API_KEY: "sk-ant-test" };

  it("calls Claude when a key is set", async () => {
    const h = harness(env);
    await run(["NJashwanth", "--out", "o.html"], h.deps);
    expect(h.calls.anthropic).toBe(1);
    expect(h.files.get("o.html")).toContain("Claude says hi.");
    expect(h.out.join("\n")).toContain("Claude (1 lines)");
    expect(h.err.join("\n")).toContain("replaced with templates");
  });

  it("--no-ai never calls Claude, even with a key", async () => {
    const h = harness(env);
    expect(await run(["NJashwanth", "--no-ai", "--out", "o.html"], h.deps)).toBe(0);
    expect(h.calls.anthropic).toBe(0);
    expect(h.out.join("\n")).toContain("template lines");
  });

  it("does not call Claude without a key or with the .env.example placeholder", async () => {
    for (const key of [undefined, "", "your-key-here"]) {
      const h = harness({ GITHUB_TOKEN: "ghp_x", ANTHROPIC_API_KEY: key });
      await run(["NJashwanth", "--out", "o.html"], h.deps);
      expect(h.calls.anthropic).toBe(0);
    }
  });

  it("still succeeds, with a warning, when Claude fails", async () => {
    const h = harness(env, { claude: () => json({ error: "overloaded" }, 529) });
    expect(await run(["NJashwanth", "--out", "o.html"], h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("Warning: Claude request failed (HTTP 529)");
    expect(h.files.get("o.html")).toContain("See you in 2027");
  });

  it("honours GIT_WRAPPED_MODEL", async () => {
    const h = harness({ ...env, GIT_WRAPPED_MODEL: "claude-custom" });
    await run(["NJashwanth", "--out", "o.html"], h.deps);
    const call = (h.fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).includes("anthropic"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string).model).toBe("claude-custom");
  });
});

describe("run: errors", () => {
  it("rejects bad arguments with exit code 2 and usage text", async () => {
    const h = harness({ GITHUB_TOKEN: "ghp_x" });
    expect(await run([], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("Missing GitHub username");
    expect(h.err.join("\n")).toContain("Usage:");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("explains a missing token without touching the network", async () => {
    for (const token of [undefined, "your-github-token"]) {
      const h = harness({ GITHUB_TOKEN: token });
      expect(await run(["NJashwanth"], h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain("GITHUB_TOKEN is not set");
      expect(h.fetchMock).not.toHaveBeenCalled();
    }
  });

  it("reports an unknown user", async () => {
    const h = harness({ GITHUB_TOKEN: "ghp_x" }, {
      contributions: () => json({ data: { user: null }, errors: [{ type: "NOT_FOUND", message: "nope" }] }),
    });
    expect(await run(["no-such-user-xyz"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain('"no-such-user-xyz" was not found');
    expect(h.files.size).toBe(0);
  });

  it("reports an invalid token", async () => {
    const h = harness({ GITHUB_TOKEN: "ghp_bad" }, { contributions: () => json({ message: "Bad credentials" }, 401) });
    expect(await run(["NJashwanth"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("rejected GITHUB_TOKEN");
  });

  it("shows the rate limit reset time", async () => {
    const reset = Math.floor(new Date("2026-11-10T12:30:00Z").getTime() / 1000);
    const h = harness({ GITHUB_TOKEN: "ghp_x" }, {
      contributions: () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }),
    });
    expect(await run(["NJashwanth"], h.deps)).toBe(1);
    const message = h.err.join("\n");
    expect(message).toContain("rate limit");
    expect(message).toContain("2026-11-10 12:30 UTC");
  });

  it("refuses to write a page for a user with zero activity", async () => {
    const h = harness({ GITHUB_TOKEN: "ghp_x" }, { contributions: (v) => json(contributions(Number(v.from.slice(0, 4)), false)) });
    expect(await run(["NJashwanth", "--year", "2020"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("no contributions in 2020");
    expect(h.err.join("\n")).toContain("--year");
    expect(h.files.size).toBe(0);
  });

  it("reports network failures and unexpected errors", async () => {
    const net = harness({ GITHUB_TOKEN: "ghp_x" });
    net.deps.fetch = (async () => {
      throw new TypeError("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await run(["NJashwanth"], net.deps)).toBe(1);
    expect(net.err.join("\n")).toContain("Could not reach GitHub");

    const disk = harness({ GITHUB_TOKEN: "ghp_x" });
    disk.deps.writeFile = async () => {
      throw new Error("EACCES: permission denied");
    };
    expect(await run(["NJashwanth"], disk.deps)).toBe(1);
    expect(disk.err.join("\n")).toContain("Unexpected error: EACCES");
  });
});
