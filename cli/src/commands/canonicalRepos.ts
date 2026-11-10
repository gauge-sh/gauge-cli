import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { z } from "zod";
import { CliError } from "../lib/client";
import { printJson } from "../lib/output";
import { resolveGithubToken } from "../lib/githubCredentials";

const searchPage = z.object({
  incomplete_results: z.boolean(),
  items: z.array(z.object({
    repository: z.object({
      full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      private: z.boolean(),
    }),
  })),
});

function invalid(message: string) {
  return new CliError("usage", message, { apiCode: "invalid_input" });
}

function unknownError() {
  return new CliError("network", "Unknown GitHub error.", { apiCode: "unknown_error" });
}

async function requestGithubWithRetry(url: URL, token: string) {
  for (let retry = 0; ; retry++) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "gauge-cli",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return response;
    const headers = response.headers;
    const exhausted = headers.get("x-ratelimit-remaining") === "0";
    const limited = response.status === 429 || (response.status === 403 &&
      (exhausted || headers.has("retry-after") ||
        /(?:secondary |API )?rate limit/i.test(await response.text())));
    if (!limited) throw unknownError();

    const now = Date.now();
    const seconds = Number(headers.get("retry-after"));
    const reset = exhausted ? Number(headers.get("x-ratelimit-reset")) * 1000 : 0;
    const minimum = Math.max(Number.isFinite(seconds) ? seconds * 1000 : 0,
      Number.isFinite(reset) ? reset - now : 0);
    const fallback = retry > 0 || minimum <= 0 ? 60_000 * 2 ** retry : 0;
    const delay = Math.max(minimum, fallback);
    const deadline = now + delay + Math.floor(Math.random() * 1000);
    const retryAt = new Date(deadline).toISOString();
    if (retry === 4) throw new CliError("network", "GitHub backoff retries exhausted.", {
      apiCode: "backoff_exhausted", details: { retryAt },
    });
    while (Date.now() < deadline) {
      console.error(`GitHub code search is rate limited. Retrying at ${retryAt}.`);
      await sleep(Math.min(60_000, deadline - Date.now()));
    }
  }
}

export async function searchGithubExampleCandidates(query: string, page: number): Promise<string[]> {
  if (!query.trim()) throw invalid("--query must not be empty.");
  if (!Number.isInteger(page) || page < 1 || page > 10) throw invalid("--page must be an integer from 1 to 10.");
  const token = resolveGithubToken();
  if (!token) throw invalid("Run gauge auth provide-gh-token or set GAUGE_GITHUB_TOKEN for GitHub code search.");
  const url = new URL("https://api.github.com/search/code");
  url.search = new URLSearchParams({ q: query.trim(), page: String(page), per_page: "100" }).toString();
  try {
    const response = await requestGithubWithRetry(url, token);
    const data = searchPage.parse(await response.json());
    if (data.incomplete_results) throw unknownError();
    const names = new Map<string, string>();
    for (const { repository } of data.items) {
      const key = repository.full_name.toLowerCase();
      if (!repository.private && !names.has(key)) names.set(key, repository.full_name);
    }
    return [...names.values()];
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw unknownError();
  }
}

export function register(program: Command) {
  program.command("canonical-repos").description("Discover canonical repository candidates")
    .command("searchGithubExampleCandidates")
    .description("Return a JSON array of public owner/repository names from one GitHub code search page")
    .requiredOption("--query <query>", "GitHub REST code search query")
    .requiredOption("--page <number>", "one-based search page (1–10)")
    .action(async (opts: { query: string; page: string }, command: Command) => {
      if (command.optsWithGlobals().hosted) throw invalid("Use canonical-repos locally.");
      const names = await searchGithubExampleCandidates(opts.query, Number(opts.page));
      printJson(names);
    });
}
