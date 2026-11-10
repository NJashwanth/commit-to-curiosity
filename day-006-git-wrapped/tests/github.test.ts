import { describe, expect, it, vi } from "vitest";
import {
  allocateBudget,
  createGitHubClient,
  fetchWrappedInput,
  GitHubError,
  yearRange,
} from "../src/github";

const NOW = new Date("2026-11-10T12:00:00Z");

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(handler: Handler) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  );
  return {
    fetchMock,
    api: createGitHubClient({
      token: "ghp_test",
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
    }),
  };
}

function expectGitHubError(err: unknown, kind: string): GitHubError {
  expect(err).toBeInstanceOf(GitHubError);
  expect((err as GitHubError).kind).toBe(kind);
  return err as GitHubError;
}

const contributionsBody = {
  data: {
    user: {
      login: "NJashwanth",
      name: "Jashwanth Neela",
      contributionsCollection: {
        totalCommitContributions: 10,
        totalPullRequestContributions: 2,
        totalIssueContributions: 1,
        totalPullRequestReviewContributions: 3,
        contributionCalendar: {
          totalContributions: 16,
          weeks: [
            {
              contributionDays: [
                { date: "2025-12-31", contributionCount: 9 }, // outside the year, dropped
                { date: "2026-01-02", contributionCount: 5 },
                { date: "2026-01-01", contributionCount: 11 },
              ],
            },
          ],
        },
        commitContributionsByRepository: [
          { repository: { nameWithOwner: "a/small", isPrivate: true }, contributions: { totalCount: 2 } },
          { repository: { nameWithOwner: "a/big", isPrivate: false }, contributions: { totalCount: 8 } },
        ],
      },
    },
  },
};

describe("missing token", () => {
  it("throws a helpful error before any request", () => {
    for (const token of [undefined, "", "   "]) {
      try {
        createGitHubClient({ token });
        expect.unreachable();
      } catch (err) {
        const e = expectGitHubError(err, "missing_token");
        expect(e.message).toContain("GITHUB_TOKEN");
      }
    }
  });
});

describe("fetchContributions", () => {
  it("parses totals, calendar and active repos, and sends the token", async () => {
    const { api, fetchMock } = client(() => json(contributionsBody));
    const data = await api.fetchContributions("NJashwanth", 2026);

    expect(data.login).toBe("NJashwanth");
    expect(data.totals).toEqual({ commits: 10, pullRequests: 2, issues: 1, reviews: 3 });
    expect(data.calendarTotal).toBe(16);
    expect(data.calendar).toEqual([
      { date: "2026-01-01", count: 11 },
      { date: "2026-01-02", count: 5 },
    ]);
    expect(data.activeRepos.map((r) => r.nameWithOwner)).toEqual(["a/big", "a/small"]);
    expect(data.activeRepos[1].isPrivate).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_test");
    const sent = JSON.parse(init.body as string);
    expect(sent.variables).toMatchObject({
      login: "NJashwanth",
      from: "2026-01-01T00:00:00Z",
      to: NOW.toISOString(),
    });
  });

  it("maps an unknown user (NOT_FOUND with null user) to not_found", async () => {
    const { api } = client(() =>
      json({
        data: { user: null },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a User with the login of 'nobody'." }],
      }),
    );
    const err = await api.fetchContributions("nobody", 2026).catch((e) => e);
    expect(expectGitHubError(err, "not_found").message).toContain('"nobody"');
  });

  it("maps a null user without errors to not_found", async () => {
    const { api } = client(() => json({ data: { user: null } }));
    const err = await api.fetchContributions("ghost", 2026).catch((e) => e);
    expectGitHubError(err, "not_found");
  });

  it("maps HTTP 404 to not_found", async () => {
    const { api } = client(() => json({ message: "Not Found" }, 404));
    const err = await api.fetchContributions("ghost", 2026).catch((e) => e);
    expectGitHubError(err, "not_found");
  });

  it("maps 401 to bad_token", async () => {
    const { api } = client(() => json({ message: "Bad credentials" }, 401));
    const err = await api.fetchContributions("NJashwanth", 2026).catch((e) => e);
    const e = expectGitHubError(err, "bad_token");
    expect(e.message).toContain("GITHUB_TOKEN");
  });

  it("maps 403 with an exhausted quota to rate_limit with the reset time", async () => {
    const reset = Math.floor(new Date("2026-11-10T12:42:00Z").getTime() / 1000);
    const { api } = client(() =>
      json({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      }),
    );
    const err = await api.fetchContributions("NJashwanth", 2026).catch((e) => e);
    const e = expectGitHubError(err, "rate_limit");
    expect(e.resetAt?.toISOString()).toBe("2026-11-10T12:42:00.000Z");
    expect(e.message).toContain("2026-11-10 12:42 UTC");
    expect(e.message).toContain("42 min");
  });

  it("uses retry-after for secondary rate limits", async () => {
    const { api } = client(() =>
      json({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "90" }),
    );
    const err = await api.fetchContributions("NJashwanth", 2026).catch((e) => e);
    const e = expectGitHubError(err, "rate_limit");
    expect(e.resetAt?.toISOString()).toBe("2026-11-10T12:01:30.000Z");
  });

  it("handles 429 and rate limits that give no reset time", async () => {
    const { api } = client(() => json({ message: "slow down" }, 429));
    const err = await api.fetchContributions("NJashwanth", 2026).catch((e) => e);
    const e = expectGitHubError(err, "rate_limit");
    expect(e.resetAt).toBeUndefined();
    expect(e.message).toContain("try again");
  });

  it("maps a GraphQL RATE_LIMITED error (HTTP 200) to rate_limit", async () => {
    const reset = Math.floor(new Date("2026-11-10T13:00:00Z").getTime() / 1000);
    const { api } = client(() =>
      json({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, 200, {
        "x-ratelimit-reset": String(reset),
      }),
    );
    const err = await api.fetchContributions("NJashwanth", 2026).catch((e) => e);
    expect(expectGitHubError(err, "rate_limit").resetAt?.toISOString()).toBe("2026-11-10T13:00:00.000Z");
  });

  it("reports other 403s and GraphQL errors as api errors", async () => {
    const forbidden = client(() => json({ message: "Resource protected by SAML" }, 403));
    const e1 = await forbidden.api.fetchContributions("x", 2026).catch((e) => e);
    expect(expectGitHubError(e1, "api").message).toContain("SAML");

    const gql = client(() => json({ errors: [{ message: "Something broke" }] }));
    const e2 = await gql.api.fetchContributions("x", 2026).catch((e) => e);
    expect(expectGitHubError(e2, "api").message).toContain("Something broke");

    const empty = client(() => json({}));
    const e3 = await empty.api.fetchContributions("x", 2026).catch((e) => e);
    expectGitHubError(e3, "api");
  });

  it("falls back to the status text when the error body is not JSON", async () => {
    const { api } = client(() => new Response("oops", { status: 500, statusText: "Server Error" }));
    const err = await api.fetchContributions("x", 2026).catch((e) => e);
    expect(expectGitHubError(err, "api").message).toContain("Server Error");
  });

  it("maps a thrown fetch to a network error", async () => {
    const { api } = client(() => {
      throw new TypeError("fetch failed");
    });
    const err = await api.fetchContributions("x", 2026).catch((e) => e);
    expect(expectGitHubError(err, "network").message).toContain("fetch failed");
  });
});

describe("fetchOwnedRepos", () => {
  const node = (name: string, pushedAt: string | null, stars = 1) => ({
    nameWithOwner: name,
    stargazerCount: stars,
    isPrivate: false,
    pushedAt,
    primaryLanguage: { name: "TypeScript" },
    languages: { edges: [{ size: 100, node: { name: "TypeScript" } }] },
  });
  const page = (nodes: unknown[], hasNextPage: boolean, endCursor = "c1") => ({
    data: { user: { repositories: { pageInfo: { hasNextPage, endCursor }, nodes } } },
  });

  it("pages until the end and maps languages and stars", async () => {
    const bodies = [
      page([node("a/one", "2026-05-01T00:00:00Z", 7), null], true, "cursor-1"),
      page([node("a/two", "2026-04-01T00:00:00Z")], false),
    ];
    const { api, fetchMock } = client(() => json(bodies.shift()));
    const repos = await api.fetchOwnedRepos("a", 2026);
    expect(repos.map((r) => r.nameWithOwner)).toEqual(["a/one", "a/two"]);
    expect(repos[0]).toMatchObject({ stars: 7, primaryLanguage: "TypeScript" });
    expect(repos[0].languages).toEqual([{ name: "TypeScript", bytes: 100 }]);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(second.variables.after).toBe("cursor-1");
  });

  it("stops at the first repo last pushed before the year", async () => {
    const { api, fetchMock } = client(() =>
      json(page([node("a/new", "2026-02-01T00:00:00Z"), node("a/old", "2025-12-31T00:00:00Z"), node("a/older", null)], true)),
    );
    const repos = await api.fetchOwnedRepos("a", 2026);
    expect(repos.map((r) => r.nameWithOwner)).toEqual(["a/new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps the number of pages", async () => {
    const { api, fetchMock } = client(() => json(page([node("a/x", "2026-02-01T00:00:00Z")], true)));
    await api.fetchOwnedRepos("a", 2026);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maps a missing user to not_found and a missing primary language to null", async () => {
    const missing = client(() => json({ data: { user: null } }));
    expectGitHubError(await missing.api.fetchOwnedRepos("a", 2026).catch((e) => e), "not_found");

    const n = { ...node("a/nolang", "2026-02-01T00:00:00Z"), primaryLanguage: null };
    const { api } = client(() => json(page([n], false)));
    expect((await api.fetchOwnedRepos("a", 2026))[0].primaryLanguage).toBeNull();
  });
});

describe("allocateBudget", () => {
  it("returns the counts untouched when they fit", () => {
    expect(allocateBudget([5, 3], 500)).toEqual([5, 3]);
  });

  it("splits proportionally and sums exactly to the cap", () => {
    const alloc = allocateBudget([900, 300, 100], 500);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(500);
    expect(alloc[0]).toBeGreaterThan(alloc[1]);
    expect(alloc[1]).toBeGreaterThan(alloc[2]);
  });

  it("never gives a repo more than it has", () => {
    const alloc = allocateBudget([1, 1000], 10);
    expect(alloc[0]).toBeLessThanOrEqual(1);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(10);
  });
});

describe("yearRange", () => {
  it("ends at now for the current year and Dec 31 for past years", () => {
    expect(yearRange(2026, NOW).to).toBe(NOW.toISOString());
    expect(yearRange(2025, NOW)).toEqual({ from: "2025-01-01T00:00:00Z", to: "2025-12-31T23:59:59Z" });
  });
});

describe("fetchCommitTimestamps", () => {
  const commit = (date: string) => ({ commit: { author: { date } } });
  const repos = [
    { nameWithOwner: "a/big", commits: 3, isPrivate: false },
    { nameWithOwner: "a/empty", commits: 2, isPrivate: false },
    { nameWithOwner: "a/gone", commits: 2, isPrivate: false },
  ];

  it("collects author dates, skipping empty and missing repos", async () => {
    const { api, fetchMock } = client((url) => {
      if (url.includes("a/big")) {
        return json([commit("2026-01-01T10:00:00Z"), commit("2026-01-02T11:00:00Z"), { commit: { committer: { date: "2026-01-03T12:00:00Z" } } }, {}]);
      }
      if (url.includes("a/empty")) return json({ message: "Git Repository is empty." }, 409);
      return json({ message: "Not Found" }, 404);
    });
    const stamps = await api.fetchCommitTimestamps("NJashwanth", 2026, repos);
    expect(stamps).toEqual(["2026-01-01T10:00:00Z", "2026-01-02T11:00:00Z", "2026-01-03T12:00:00Z"]);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/repos/a/big/commits");
    expect(url).toContain("author=NJashwanth");
    expect(url).toContain("since=2026-01-01T00%3A00%3A00Z");
  });

  it("paginates and respects the cap", async () => {
    const pageOf = (n: number) => Array.from({ length: n }, (_, i) => commit(`2026-02-01T${String(i % 24).padStart(2, "0")}:00:00Z`));
    const { api, fetchMock } = client((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const perPage = Number(new URL(url).searchParams.get("per_page"));
      return json(pageOf(page <= 3 ? perPage : 0));
    });
    const stamps = await api.fetchCommitTimestamps("u", 2026, [{ nameWithOwner: "a/busy", commits: 5000, isPrivate: false }], 250);
    expect(stamps).toHaveLength(250);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 100 + 100 + 50
  });

  it("stops paging when a short page comes back", async () => {
    const { api, fetchMock } = client(() => json([commit("2026-02-01T01:00:00Z")]));
    const stamps = await api.fetchCommitTimestamps("u", 2026, [{ nameWithOwner: "a/x", commits: 40, isPrivate: false }]);
    expect(stamps).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces rate limits and bad tokens instead of hiding them", async () => {
    const limited = client(() => json({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793000000" }));
    expectGitHubError(await limited.api.fetchCommitTimestamps("u", 2026, repos).catch((e) => e), "rate_limit");

    const bad = client(() => json({ message: "Bad credentials" }, 401));
    expectGitHubError(await bad.api.fetchCommitTimestamps("u", 2026, repos).catch((e) => e), "bad_token");

    const broken = client(() => json({ message: "boom" }, 500));
    expectGitHubError(await broken.api.fetchCommitTimestamps("u", 2026, repos).catch((e) => e), "api");
  });
});

describe("fetchWrappedInput", () => {
  it("runs the three fetches in order and reports progress", async () => {
    const calls: string[] = [];
    const fake = {
      fetchContributions: async () => {
        calls.push("contributions");
        return { login: "Canonical", activeRepos: [{ nameWithOwner: "c/r", commits: 1, isPrivate: false }] } as never;
      },
      fetchOwnedRepos: async (login: string) => {
        calls.push(`repos:${login}`);
        return [];
      },
      fetchCommitTimestamps: async (login: string) => {
        calls.push(`commits:${login}`);
        return ["2026-01-01T00:00:00Z"];
      },
    };
    const progress: string[] = [];
    const input = await fetchWrappedInput(fake, "canonical", 2026, (m) => progress.push(m));
    expect(calls).toEqual(["contributions", "repos:Canonical", "commits:Canonical"]);
    expect(progress).toHaveLength(3);
    expect(input.commitTimestamps).toEqual(["2026-01-01T00:00:00Z"]);
    await fetchWrappedInput(fake, "canonical", 2026); // default no-op progress
  });
});
