import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { repoExampleSchema, repoNamesSchema, type RepoExample } from "@withgauge/api-schemas/canonicalRepos";
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

async function requestGithubWithRetry(url: URL, token: string, expectedStatuses: number[] = [], accept = "application/vnd.github+json") {
  for (let retry = 0; ; retry++) {
    const response = await fetch(url, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "User-Agent": "gauge-cli",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok || expectedStatuses.includes(response.status)) return response;
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
      console.error(`GitHub request to ${url.pathname} is rate limited. Retrying at ${retryAt}.`);
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

const repositoryPage = z.object({
  incomplete_results: z.boolean(),
  items: z.array(z.object({
    full_name: z.string(),
    private: z.boolean(),
    default_branch: z.string().min(1),
  })),
});
const commits = z.array(z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }));

async function countCommits(base: URL, sha: string, token: string, name: string) {
  const url = new URL("commits", base);
  url.search = new URLSearchParams({ sha, per_page: "1" }).toString();
  const first = await requestGithubWithRetry(url, token);
  const firstPage = commits.parse(await first.json());
  const links = first.headers.get("link") ?? "";
  const last = links.match(/<([^>]+)>;\s*rel="last"/);
  if (last) {
    const count = Number(new URL(last[1]).searchParams.get("page"));
    if (!Number.isSafeInteger(count) || count < 1) throw unknownError();
    return count;
  }
  if (!links.includes('rel="next"')) return firstPage.length;

  // Some responses omit the last page. Count larger pages at the same commit.
  console.error(`${name}: GitHub omitted the last page number. Counting commits in pages of 100.`);
  url.searchParams.set("per_page", "100");
  let count = 0;
  for (let page = 1; ; page++) {
    url.searchParams.set("page", String(page));
    const response = await requestGithubWithRetry(url, token);
    count += commits.parse(await response.json()).length;
    if (!response.headers.get("link")?.includes('rel="next"')) return count;
  }
}

async function fetchExample(name: string, token: string): Promise<RepoExample | null> {
  function skip(reason: string): null {
    console.error(`${name}: skipped — ${reason}.`);
    return null;
  }
  const search = new URL("https://api.github.com/search/repositories");
  search.searchParams.set("q", `repo:${name} fork:true`);
  const response = await requestGithubWithRetry(search, token);
  const page = repositoryPage.parse(await response.json());
  if (page.incomplete_results) throw unknownError();
  const repo = page.items.find(item => !item.private && item.full_name.toLowerCase() === name.toLowerCase());
  if (!repo) return skip("no matching public repository");

  const base = new URL(`https://api.github.com/repos/${repo.full_name}/`);
  const tipUrl = new URL("commits", base);
  tipUrl.search = new URLSearchParams({ sha: repo.default_branch, per_page: "1" }).toString();
  const tip = await requestGithubWithRetry(tipUrl, token, [409]);
  if (tip.status === 409) {
    const body = z.object({ message: z.string() }).parse(await tip.json());
    if (body.message === "Git Repository is empty.") return skip("empty repository (0 commits)");
    throw unknownError();
  }
  const [head] = commits.parse(await tip.json());
  if (!head) return skip("default branch has 0 commits");
  const commitCount = await countCommits(base, head.sha, token, repo.full_name);
  if (commitCount < 20) return skip(`${commitCount} commits, minimum 20`);

  const readmeUrl = new URL("readme", base);
  readmeUrl.searchParams.set("ref", head.sha);
  const file = await requestGithubWithRetry(readmeUrl, token, [404], "application/vnd.github.raw+json");
  if (file.status === 404) return skip("README not found");
  const readme = await file.text();
  if (!readme.trim()) return skip("README is empty");
  const responseLanguages = await requestGithubWithRetry(new URL("languages", base), token);
  const bytes = z.record(z.string(), z.number().nonnegative()).parse(await responseLanguages.json());
  return repoExampleSchema.parse({
    url: `https://github.com/${repo.full_name}`,
    languages: Object.keys(bytes).sort(),
    commitCount,
    readme,
  });
}

export async function getGithubExamples(names: string[]): Promise<RepoExample[]> {
  const parsed = repoNamesSchema.safeParse(names);
  if (!parsed.success) throw invalid("Expected a JSON array of up to 100 owner/repository names.");
  if (!names.length) return [];
  const token = resolveGithubToken();
  if (!token) throw invalid("Run gauge auth provide-gh-token or set GAUGE_GITHUB_TOKEN.");
  const examples: RepoExample[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      console.error(`${name}: skipped — duplicate input.`);
      continue;
    }
    seen.add(key);
    try {
      const example = await fetchExample(name, token);
      if (example) {
        examples.push(example);
        console.error(`${name}: eligible — ${example.commitCount} commits, README found.`);
      }
    } catch (cause) {
      const error = cause instanceof CliError ? cause : unknownError();
      console.error(`${name}: failed — ${error.message}`);
      throw new CliError(error.code, error.message, {
        apiCode: error.apiCode,
        details: { ...error.details, repository: name, partialData: examples },
      });
    }
  }
  return examples;
}

export function register(program: Command) {
  const group = program.command("canonical-repos").description("Discover canonical repository candidates");
  group
    .command("searchGithubExampleCandidates")
    .description("Return a JSON array of public owner/repository names from one GitHub code search page")
    .requiredOption("--query <query>", "GitHub REST code search query")
    .requiredOption("--page <number>", "one-based search page (1–10)")
    .action(async (opts: { query: string; page: string }, command: Command) => {
      if (command.optsWithGlobals().hosted) throw invalid("Use canonical-repos locally.");
      const names = await searchGithubExampleCandidates(opts.query, Number(opts.page));
      printJson(names);
    });
  group.command("getGithubExamples")
    .description("Append eligible repository examples to a JSONL file and print its path")
    .requiredOption("--file <path>", "JSON array of owner/repository names")
    .option("--output-file <path>", "JSONL file to append examples to", "github-examples.jsonl")
    .action(async (opts: { file: string; outputFile: string }, command: Command) => {
      if (command.optsWithGlobals().hosted) throw invalid("Use canonical-repos locally.");
      const destination = resolve(opts.outputFile);
      if (!relative(opts.file, destination)) throw invalid("Choose an output file distinct from --file.");
      let names;
      try {
        names = JSON.parse((await readFile(opts.file, "utf8")).replace(/^\uFEFF/, ""));
      } catch {
        throw invalid("Could not read a JSON array from --file.");
      }
      const examples = await getGithubExamples(names);
      await mkdir(dirname(destination), { recursive: true });
      await appendFile(destination, examples.map(example => JSON.stringify(example) + "\n").join(""), "utf8");
      console.log(destination);
    });
}
