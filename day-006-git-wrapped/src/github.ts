import type { CalendarDay, ContributionData, OwnedRepo, RepoActivity } from "./types";
import { formatDateTime } from "./util";

const API_URL = "https://api.github.com";
const MAX_REPO_PAGES = 3;
const COMMIT_CAP = 500;
const COMMIT_REPOS = 10;

export type GitHubErrorKind =
  | "missing_token"
  | "bad_token"
  | "not_found"
  | "rate_limit"
  | "network"
  | "api";

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    /** For rate limits: when GitHub will let us back in, if it told us. */
    readonly resetAt?: Date,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface ClientOptions {
  token: string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
  apiUrl?: string;
}

export interface GitHubClient {
  fetchContributions(login: string, year: number): Promise<ContributionData>;
  fetchOwnedRepos(login: string, year: number): Promise<OwnedRepo[]>;
  fetchCommitTimestamps(
    login: string,
    year: number,
    repos: RepoActivity[],
    cap?: number,
  ): Promise<string[]>;
}

/** Start and end of the requested year. The current year ends "now" so the calendar stops today. */
export function yearRange(year: number, now: Date): { from: string; to: string } {
  const from = `${year}-01-01T00:00:00Z`;
  const to = year === now.getUTCFullYear() ? now.toISOString() : `${year}-12-31T23:59:59Z`;
  return { from, to };
}

/**
 * Split a commit budget across repos in proportion to their activity.
 * If everything fits, every repo gets all of its commits.
 */
export function allocateBudget(counts: number[], cap: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= cap) return [...counts];
  const alloc = counts.map((c) => Math.floor((cap * c) / total));
  let leftover = cap - alloc.reduce((a, b) => a + b, 0);
  for (let i = 0; leftover > 0 && i < alloc.length; i++) {
    if (alloc[i] < counts[i]) {
      alloc[i] += 1;
      leftover -= 1;
    }
  }
  return alloc;
}

function rateLimitError(resetAt: Date | undefined, now: Date): GitHubError {
  if (!resetAt) {
    return new GitHubError(
      "rate_limit",
      "GitHub rate limit reached. It did not say when it resets, so try again in a few minutes.",
    );
  }
  const minutes = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 60_000));
  return new GitHubError(
    "rate_limit",
    `GitHub rate limit reached. It resets at ${formatDateTime(resetAt)} (in about ${minutes} min).`,
    resetAt,
  );
}

function resetFromHeaders(headers: Headers, now: Date): Date | undefined {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (reset > 0) return new Date(reset * 1000);
  const retryAfter = Number(headers.get("retry-after"));
  if (retryAfter > 0) return new Date(now.getTime() + retryAfter * 1000);
  return undefined;
}

async function readMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export function createGitHubClient(options: ClientOptions): GitHubClient {
  const token = options.token?.trim();
  if (!token) {
    throw new GitHubError(
      "missing_token",
      "GITHUB_TOKEN is not set. Create a read-only token at https://github.com/settings/tokens and put it in .env (see .env.example).",
    );
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const apiUrl = options.apiUrl ?? API_URL;

  async function send(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await doFetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "git-wrapped",
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new GitHubError("network", `Could not reach GitHub: ${(err as Error).message}`);
    }
  }

  /** Turn a failed response into the right GitHubError. 404 is left to the caller. */
  async function failure(res: Response): Promise<GitHubError> {
    const message = await readMessage(res);
    if (res.status === 401) {
      return new GitHubError(
        "bad_token",
        "GitHub rejected GITHUB_TOKEN (401 Bad credentials). Check that the token is correct and has not expired.",
      );
    }
    const limited =
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.get("x-ratelimit-remaining") === "0" ||
          res.headers.has("retry-after") ||
          /rate limit/i.test(message)));
    if (limited) return rateLimitError(resetFromHeaders(res.headers, now()), now());
    return new GitHubError("api", `GitHub API error ${res.status}: ${message}`);
  }

  interface GraphQLResponse<T> {
    data?: T;
    errors?: { type?: string; message: string }[];
  }

  async function graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    notFound: string,
  ): Promise<T> {
    const res = await send(`${apiUrl}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      if (res.status === 404) throw new GitHubError("not_found", notFound);
      throw await failure(res);
    }
    const body = (await res.json()) as GraphQLResponse<T>;
    const errors = body.errors ?? [];
    if (errors.some((e) => e.type === "RATE_LIMITED")) {
      throw rateLimitError(resetFromHeaders(res.headers, now()), now());
    }
    if (errors.some((e) => e.type === "NOT_FOUND")) {
      throw new GitHubError("not_found", notFound);
    }
    if (errors.length > 0) {
      throw new GitHubError("api", `GitHub GraphQL error: ${errors.map((e) => e.message).join("; ")}`);
    }
    if (!body.data) throw new GitHubError("api", "GitHub returned an empty response.");
    return body.data;
  }

  const CONTRIBUTIONS_QUERY = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        login
        name
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount } }
          }
          commitContributionsByRepository(maxRepositories: ${COMMIT_REPOS}) {
            repository { nameWithOwner isPrivate }
            contributions { totalCount }
          }
        }
      }
    }`;

  interface ContributionsResponse {
    user: null | {
      login: string;
      name: string | null;
      contributionsCollection: {
        totalCommitContributions: number;
        totalPullRequestContributions: number;
        totalIssueContributions: number;
        totalPullRequestReviewContributions: number;
        contributionCalendar: {
          totalContributions: number;
          weeks: { contributionDays: { date: string; contributionCount: number }[] }[];
        };
        commitContributionsByRepository: {
          repository: { nameWithOwner: string; isPrivate: boolean };
          contributions: { totalCount: number };
        }[];
      };
    };
  }

  const REPOS_QUERY = `
    query($login: String!, $after: String) {
      user(login: $login) {
        repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false,
                     orderBy: { field: PUSHED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            nameWithOwner
            stargazerCount
            isPrivate
            pushedAt
            primaryLanguage { name }
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name } }
            }
          }
        }
      }
    }`;

  interface ReposResponse {
    user: null | {
      repositories: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ({
          nameWithOwner: string;
          stargazerCount: number;
          isPrivate: boolean;
          pushedAt: string | null;
          primaryLanguage: { name: string } | null;
          languages: { edges: { size: number; node: { name: string } }[] };
        } | null)[];
      };
    };
  }

  const notFoundMessage = (login: string) =>
    `GitHub user "${login}" was not found. Check the spelling of the username.`;

  return {
    async fetchContributions(login, year) {
      const { from, to } = yearRange(year, now());
      const data = await graphql<ContributionsResponse>(
        CONTRIBUTIONS_QUERY,
        { login, from, to },
        notFoundMessage(login),
      );
      if (!data.user) throw new GitHubError("not_found", notFoundMessage(login));
      const c = data.user.contributionsCollection;
      const calendar: CalendarDay[] = c.contributionCalendar.weeks
        .flatMap((w) => w.contributionDays)
        .filter((d) => d.date.startsWith(`${year}-`))
        .map((d) => ({ date: d.date, count: d.contributionCount }))
        .sort((a, b) => a.date.localeCompare(b.date));
      return {
        login: data.user.login,
        name: data.user.name,
        year,
        totals: {
          commits: c.totalCommitContributions,
          pullRequests: c.totalPullRequestContributions,
          issues: c.totalIssueContributions,
          reviews: c.totalPullRequestReviewContributions,
        },
        calendarTotal: c.contributionCalendar.totalContributions,
        calendar,
        activeRepos: c.commitContributionsByRepository
          .map((r) => ({
            nameWithOwner: r.repository.nameWithOwner,
            commits: r.contributions.totalCount,
            isPrivate: r.repository.isPrivate,
          }))
          .sort((a, b) => b.commits - a.commits),
      };
    },

    async fetchOwnedRepos(login, year) {
      const yearStart = `${year}-01-01T00:00:00Z`;
      const repos: OwnedRepo[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_REPO_PAGES; page++) {
        const data: ReposResponse = await graphql<ReposResponse>(
          REPOS_QUERY,
          { login, after },
          notFoundMessage(login),
        );
        if (!data.user) throw new GitHubError("not_found", notFoundMessage(login));
        const { nodes, pageInfo } = data.user.repositories;
        let reachedOlder = false;
        for (const node of nodes) {
          if (!node) continue;
          // Ordered by push date, so once we pass the start of the year we can stop.
          if (!node.pushedAt || node.pushedAt < yearStart) {
            reachedOlder = true;
            break;
          }
          repos.push({
            nameWithOwner: node.nameWithOwner,
            stars: node.stargazerCount,
            isPrivate: node.isPrivate,
            pushedAt: node.pushedAt,
            primaryLanguage: node.primaryLanguage?.name ?? null,
            languages: node.languages.edges.map((e) => ({ name: e.node.name, bytes: e.size })),
          });
        }
        if (reachedOlder || !pageInfo.hasNextPage) break;
        after = pageInfo.endCursor;
      }
      return repos;
    },

    async fetchCommitTimestamps(login, year, repos, cap = COMMIT_CAP) {
      const top = repos.slice(0, COMMIT_REPOS);
      const { from, to } = yearRange(year, now());
      const budgets = allocateBudget(
        top.map((r) => r.commits),
        cap,
      );
      const timestamps: string[] = [];

      for (let i = 0; i < top.length; i++) {
        let remaining = budgets[i];
        for (let page = 1; remaining > 0; page++) {
          const perPage = Math.min(100, remaining);
          const url =
            `${apiUrl}/repos/${top[i].nameWithOwner}/commits` +
            `?author=${encodeURIComponent(login)}&since=${encodeURIComponent(from)}` +
            `&until=${encodeURIComponent(to)}&per_page=${perPage}&page=${page}`;
          const res = await send(url);
          // Empty (409), gone (404) or blocked (451) repos just contribute nothing.
          if ([404, 409, 451].includes(res.status)) break;
          if (!res.ok) throw await failure(res);
          const commits = (await res.json()) as {
            commit?: { author?: { date?: string }; committer?: { date?: string } };
          }[];
          for (const c of commits) {
            const date = c.commit?.author?.date ?? c.commit?.committer?.date;
            if (date) timestamps.push(date);
          }
          remaining -= commits.length;
          if (commits.length < perPage) break;
        }
      }
      return timestamps.slice(0, cap);
    },
  };
}

export interface WrappedInput {
  contributions: ContributionData;
  repos: OwnedRepo[];
  commitTimestamps: string[];
}

/** Everything the stats engine needs, fetched in the order the CLI reports progress. */
export async function fetchWrappedInput(
  client: GitHubClient,
  login: string,
  year: number,
  onProgress: (message: string) => void = () => {},
): Promise<WrappedInput> {
  onProgress("Fetching contributions");
  const contributions = await client.fetchContributions(login, year);
  onProgress("Fetching repositories");
  const repos = await client.fetchOwnedRepos(contributions.login, year);
  onProgress("Sampling commit timestamps");
  const commitTimestamps = await client.fetchCommitTimestamps(
    contributions.login,
    year,
    contributions.activeRepos,
  );
  return { contributions, repos, commitTimestamps };
}
