import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGitHubClient, fetchWrappedInput, GitHubError } from "./github";
import { narrate } from "./narrate";
import { pickPersona } from "./persona";
import { renderHtml } from "./render";
import { computeStats, isValidTimeZone } from "./stats";

export const USAGE = `git-wrapped: a Spotify Wrapped style year in review for any GitHub user.

Usage:
  npx tsx src/cli.ts <username> [options]

Options:
  --year <yyyy>   Year to wrap (default: the current year)
  --out <file>    Output file (default: git-wrapped-<username>-<year>.html)
  --no-ai         Skip Claude and use template lines, even if ANTHROPIC_API_KEY is set
  --tz <zone>     IANA time zone for the hour-of-day chart (default: UTC), e.g. America/New_York
  -h, --help      Show this help

Environment (or a .env file):
  GITHUB_TOKEN        required, read-only scope is enough
  ANTHROPIC_API_KEY   optional, enables Claude-written slide lines
  GIT_WRAPPED_MODEL   optional, override the Claude model
`;

export class UsageError extends Error {}

export interface CliArgs {
  login: string;
  year: number;
  out: string;
  noAi: boolean;
  timeZone: string;
  help: boolean;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const FIRST_GITHUB_YEAR = 2008;

export function parseCliArgs(argv: string[], now: Date = new Date()): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        year: { type: "string" },
        out: { type: "string" },
        "no-ai": { type: "boolean", default: false },
        tz: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  const currentYear = now.getUTCFullYear();

  if (values.help) {
    return { login: "", year: currentYear, out: "", noAi: false, timeZone: "UTC", help: true };
  }
  if (positionals.length === 0) throw new UsageError("Missing GitHub username.");
  if (positionals.length > 1) throw new UsageError(`Expected one username, got ${positionals.length}.`);

  const login = positionals[0].replace(/^@/, "");
  if (!LOGIN_RE.test(login)) throw new UsageError(`"${positionals[0]}" is not a valid GitHub username.`);

  let year = currentYear;
  if (values.year !== undefined) {
    if (!/^\d{4}$/.test(values.year)) throw new UsageError(`--year must be a 4 digit year, got "${values.year}".`);
    year = Number(values.year);
    if (year < FIRST_GITHUB_YEAR || year > currentYear) {
      throw new UsageError(`--year must be between ${FIRST_GITHUB_YEAR} and ${currentYear}.`);
    }
  }

  const timeZone = values.tz ?? "UTC";
  if (!isValidTimeZone(timeZone)) throw new UsageError(`Unknown time zone "${timeZone}". Try something like Europe/Berlin.`);

  return {
    login,
    year,
    out: values.out ?? `git-wrapped-${login}-${year}.html`,
    noAi: values["no-ai"] ?? false,
    timeZone,
    help: false,
  };
}

/** Parse KEY=VALUE lines. Comments, blank lines and surrounding quotes are handled. */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (key) out[key] = value;
  }
  return out;
}

/** Empty values and the placeholders from .env.example count as "not set". */
export function secret(value: string | undefined): string | undefined {
  const v = value?.trim();
  return !v || v.startsWith("your-") ? undefined : v;
}

export interface CliDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => Date;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  writeFile: (path: string, data: string) => Promise<void>;
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv, deps.now());
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    deps.stderr(`Error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    deps.stdout(USAGE);
    return 0;
  }

  try {
    const client = createGitHubClient({
      token: secret(deps.env.GITHUB_TOKEN),
      fetch: deps.fetch,
      now: deps.now,
    });
    const input = await fetchWrappedInput(client, args.login, args.year, (m) => deps.stderr(`${m}...`));
    const stats = computeStats({ ...input, timeZone: args.timeZone, today: deps.now() });

    if (stats.totalContributions === 0) {
      deps.stderr(
        `${stats.login} has no contributions in ${args.year}, so there is nothing to wrap. ` +
          `Try another year with --year, and note that private activity only counts if your token can see it.`,
      );
      return 1;
    }

    const persona = pickPersona(stats);
    const narration = await narrate(stats, persona, {
      apiKey: secret(deps.env.ANTHROPIC_API_KEY),
      noAi: args.noAi,
      model: deps.env.GIT_WRAPPED_MODEL || undefined,
      fetch: deps.fetch,
    });
    if (narration.warning) deps.stderr(`Warning: ${narration.warning}`);

    const html = renderHtml({ stats, persona, lines: narration.lines });
    await deps.writeFile(args.out, html);

    const narrator =
      narration.source === "ai" ? `Claude (${narration.aiLineCount} lines)` : "template lines";
    deps.stdout(
      `Wrote ${args.out} (${Math.round(html.length / 1024)} KB) for ${stats.login}, ${args.year}.\n` +
        `Persona: ${persona.label}. Narration: ${narrator}. Hours shown in ${stats.timeZone}.\n` +
        `Open it in a browser, then tap or use the arrow keys.`,
    );
    return 0;
  } catch (err) {
    if (err instanceof GitHubError) {
      deps.stderr(`Error: ${err.message}`);
    } else {
      deps.stderr(`Unexpected error: ${(err as Error).message}`);
    }
    return 1;
  }
}

/* v8 ignore start: process entry point, exercised by running the CLI for real */
function loadDotEnvFile(path = ".env"): void {
  try {
    const values = parseDotEnv(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env file is fine.
  }
}

async function main(): Promise<void> {
  loadDotEnvFile();
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    now: () => new Date(),
    stdout: (m) => console.log(m),
    stderr: (m) => console.error(m),
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, "utf8");
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
/* v8 ignore stop */
