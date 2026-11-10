import { appendFile, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { openLocalStore } from "../lib/localStore";
import { findWorkspace } from "../lib/gaugeState";
import canonicalFileDefinition from "../../api-schemas/canonicalFile.schema.json";
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

function githubError(message: string) {
  return new CliError("network", message, { apiCode: "unknown_error" });
}

async function requestGithubWithRetry(url: URL, token: string, expectedStatuses: number[] = [], accept = "application/vnd.github+json", write?: { method: "POST" | "PUT"; body: string }) {
  for (let retry = 0; ; retry++) {
    const operation = `${write?.method ?? "GET"} ${url.pathname}`;
    const redact = (message: string) => message.replaceAll(token, "[redacted]");
    const response = await fetch(url, {
      ...write,
      headers: {
        ...(write && { "Content-Type": "application/json" }),
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "User-Agent": "gauge-cli",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }).catch((error: Error) => {
      const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
      throw githubError(redact(`GitHub ${operation} failed: ${error.message}${cause}`));
    });
    if (response.ok || expectedStatuses.includes(response.status)) return response;
    const headers = response.headers;
    const body = await response.text();
    const diagnostic = redact(`GitHub ${operation} returned HTTP ${response.status} ${response.statusText}\n${body || "(empty response body)"}`);
    const exhausted = headers.get("x-ratelimit-remaining") === "0";
    const limited = response.status === 429 || (response.status === 403 &&
      (exhausted || headers.has("retry-after") ||
        /(?:secondary |API )?rate limit/i.test(body)));
    if (!limited) throw githubError(diagnostic);

    const now = Date.now();
    const seconds = Number(headers.get("retry-after"));
    const reset = exhausted ? Number(headers.get("x-ratelimit-reset")) * 1000 : 0;
    const minimum = Math.max(Number.isFinite(seconds) ? seconds * 1000 : 0,
      Number.isFinite(reset) ? reset - now : 0);
    const fallback = retry > 0 || minimum <= 0 ? 60_000 * 2 ** retry : 0;
    const delay = Math.max(minimum, fallback);
    const deadline = now + delay + Math.floor(Math.random() * 1000);
    const retryAt = new Date(deadline).toISOString();
    if (retry === 4) throw new CliError("network", `GitHub backoff retries exhausted.\n${diagnostic}`, {
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
    if (data.incomplete_results) throw githubError("GitHub returned incomplete code search results.");
    const names = new Map<string, string>();
    for (const { repository } of data.items) {
      const key = repository.full_name.toLowerCase();
      if (!repository.private && !names.has(key)) names.set(key, repository.full_name);
    }
    return [...names.values()];
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw githubError(`Invalid GitHub search response: ${String(error)}`);
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
    if (!Number.isSafeInteger(count) || count < 1) throw githubError("GitHub returned an invalid last commit page.");
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
  if (page.incomplete_results) throw githubError("GitHub returned incomplete repository search results.");
  const repo = page.items.find(item => !item.private && item.full_name.toLowerCase() === name.toLowerCase());
  if (!repo) return skip("no matching public repository");

  const base = new URL(`https://api.github.com/repos/${repo.full_name}/`);
  const tipUrl = new URL("commits", base);
  tipUrl.search = new URLSearchParams({ sha: repo.default_branch, per_page: "1" }).toString();
  const tip = await requestGithubWithRetry(tipUrl, token, [409]);
  if (tip.status === 409) {
    const body = z.object({ message: z.string() }).parse(await tip.json());
    if (body.message === "Git Repository is empty.") return skip("empty repository (0 commits)");
    throw githubError(`GitHub GET ${tipUrl.pathname} returned HTTP 409: ${body.message.replaceAll(token, "[redacted]")}`);
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
      const error = cause instanceof CliError ? cause : githubError(String(cause));
      console.error(`${name}: failed — ${error.message}`);
      throw new CliError(error.code, error.message, {
        apiCode: error.apiCode,
        details: { ...error.details, repository: name, partialData: examples },
      });
    }
  }
  return examples;
}

const fields = canonicalFileDefinition.items.properties;
const canonicalList = z.array(z.strictObject({
  name: z.string().regex(new RegExp(fields.name.pattern)).trim(),
  description: z.string().regex(new RegExp(fields.description.pattern)),
  repos: z.array(z.string().regex(new RegExp(fields.repos.items.pattern)))
    .min(fields.repos.minItems).refine(urls => new Set(urls.map(url => url.toLowerCase())).size === urls.length,
      "Source repository URLs must be unique within a group."),
  Readme: z.string().regex(new RegExp(fields.Readme.pattern)).nullable(),
}));

async function flushCanonical(opts: { file: string; name: string }) {
  let input: unknown;
  try {
    input = JSON.parse((await readFile(opts.file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    throw invalid("Could not read a JSON list from --file.");
  }
  const groups = canonicalList.parse(input);
  const matches = groups.filter(group => group.name.toLowerCase() === opts.name.trim().toLowerCase());
  if (matches.length !== 1) throw invalid("Select exactly one canonical in the file with --name.");
  const record = matches[0];
  const store = openLocalStore(resolve(findWorkspace() ?? process.cwd(), ".gauge"));
  let createdUrl: string | undefined;
  try {
    // Serialize the name check and insert across simultaneous CLI invocations.
    store.db.exec("BEGIN IMMEDIATE");
    if (store.db.prepare("SELECT 1 FROM canonical_repos WHERE name = ?").get(record.name))
      throw invalid(`Canonical name "${record.name}" already exists. Try another name.`);
    if (!record.Readme) throw invalid("Complete the approved canonical's Readme before publishing.");
    const slug = record.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug || slug.length > 100) throw invalid("Choose a name that yields a GitHub repository name of 1–100 characters.");
    const token = resolveGithubToken();
    if (!token) throw invalid("Run gauge auth provide-gh-token or set GAUGE_GITHUB_TOKEN.");
    const api = (path: string) => new URL(path, "https://api.github.com");
    const user = await requestGithubWithRetry(api("/user"), token);
    const { login } = z.object({ login: z.string().min(1) }).parse(await user.json());
    const target = `${login}/${slug}`;
    const url = `https://github.com/${target}`;
    // Keep the GitHub ID locally until the README and database row are both saved.
    const key = createHash("sha256").update(target.toLowerCase()).digest("hex");
    const receipt = resolve(store.gaugeDir, `pending-canonical-${key}.json`);
    let pendingId: number | undefined;
    try {
      pendingId = z.number().int().positive().parse(JSON.parse(await readFile(receipt, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (pendingId !== undefined) {
      const existing = await requestGithubWithRetry(api(`/repos/${target}`), token);
      const repo = z.object({ id: z.number(), private: z.boolean() }).parse(await existing.json());
      if (repo.id !== pendingId || repo.private) throw invalid(`Pending public repository identity changed at ${url}.`);
      createdUrl = url;
    } else {
      const response = await requestGithubWithRetry(api("/user/repos"), token, [], undefined, {
        method: "POST", body: JSON.stringify({ name: slug, private: false, auto_init: false }),
      });
      createdUrl = url;
      const { id } = z.object({ id: z.number().int().positive() }).parse(await response.json());
      await writeFile(receipt + ".tmp", JSON.stringify(id));
      await rename(receipt + ".tmp", receipt);
    }
    const contents = api(`/repos/${target}/contents/README.md`);
    const prior = pendingId === undefined ? undefined :
      await requestGithubWithRetry(contents, token, [404], "application/vnd.github.raw+json");
    if (!prior || prior.status === 404) {
      await requestGithubWithRetry(contents, token, [], undefined, {
        method: "PUT", body: JSON.stringify({
          message: "Add canonical README", content: Buffer.from(record.Readme).toString("base64"),
        }),
      });
    } else if (await prior.text() !== record.Readme) {
      throw invalid("The published README differs from the selected record.");
    }
    store.db.prepare('INSERT INTO canonical_repos (url,name,description,"source-repos") VALUES (?,?,?,?)')
      .run(url, record.name, record.description, JSON.stringify(record.repos));
    store.db.exec("COMMIT");
    await rm(receipt, { force: true }).catch(() => console.error(`Saved canonical. Pending receipt remains at ${receipt}.`));
    return url;
  } catch (error) {
    if (createdUrl) throw new CliError("internal", `Repository exists at ${createdUrl}, but flush did not complete: ${error instanceof Error ? error.message : "unknown error"}`);
    throw error;
  } finally {
    store.close(); // Closing rolls back any unfinished transaction.
  }
}

export function register(program: Command) {
  const group = program.command("canonical-repos").description("Discover canonical repository candidates");
  group.command("flush-canonical-repos")
    .description("Publish one approved canonical README and save its local catalog entry")
    .requiredOption("--file <path>", "canonical JSON list")
    .requiredOption("--name <name>", "group name in the list")
    .action(async (opts: { file: string; name: string }, command: Command) => {
      if (command.optsWithGlobals().hosted) throw invalid("Use canonical-repos locally.");
      console.log(await flushCanonical(opts));
    });
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
