import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { Command } from "commander";
import { CliError } from "../lib/client";
import {
  addPageOptions,
  type ChatScope,
  categoryScope,
  chatPath,
  chatScope,
  csv,
  fetchPages,
  type Page,
  type PageOptions,
  printPage,
  truncate,
  withCategory,
} from "../lib/chatApi";
import { resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

const MAX_ANSWER_LIMIT = 100;

type Answer = {
  id: string;
  promptId: string;
  topicId: string | null;
  model: string;
  day: string;
  createdAt: string;
  text: string;
  brandIds: string[];
};
type AnswerDetail = Omit<Answer, "brandIds"> & {
  promptText: string;
  mentions: {
    brandId: string;
    name: string;
    mentionTypes: string[];
    count: number;
  }[];
  citations: {
    pageId: string;
    url: string;
    title: string | null;
    domain: string;
  }[];
  searchQueries: string[];
};
type Citation = {
  answerId: string;
  pageId: string;
  promptId: string;
  model: string;
  day: string;
  domain: string;
  url: string;
};
type ExportFile = { kind: string; url: string; expiresAt: string };
export type Export = {
  id: string;
  status: "pending" | "completed";
  dateRange: { since: string; until: string };
  createdAt: string;
  completedAt: string | null;
  files?: ExportFile[];
};

type RowOpts = PageOptions & {
  since?: string;
  until?: string;
  model?: string;
  prompt?: string;
  topic?: string;
  tag?: string;
  trackingType?: string;
  brand?: string;
  brandAbsent?: string;
  domain?: string;
  page?: string;
};

const list = (raw?: string) => (raw ? csv(raw) : undefined);

function rowFilters(command: Command): Command {
  return command
    .option(
      "--since <date>",
      "YYYY-MM-DD (default 7 days ago; ranges ≤ 92 days)",
    )
    .option("--until <date>", "YYYY-MM-DD (default today)")
    .option("--model <models>", "comma-separated models")
    .option("--prompt <ids>", "comma-separated prm_ ids")
    .option("--topic <ids>", "comma-separated top_ ids")
    .option("--tag <ids>", "comma-separated tag_ ids")
    .option(
      "--tracking-type <type>",
      "visibility (default) | branded_own | all",
    );
}

function rowQuery(opts: RowOpts) {
  return {
    since: opts.since,
    until: opts.until,
    model: list(opts.model),
    prompt: list(opts.prompt),
    topic: list(opts.topic),
    tag: list(opts.tag),
    trackingType: opts.trackingType,
  };
}

function seconds(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new CliError("usage", `${flag} must be a number of seconds`);
  return value;
}

async function download(
  exp: Export,
  dir: string,
): Promise<{ kind: string; path: string; bytes: number }[]> {
  if (exp.status !== "completed" || !exp.files?.length)
    throw new CliError(
      "usage",
      `Export ${exp.id} is ${exp.status}; it has no files yet. Pass --wait to wait for it.`,
    );
  mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const file of exp.files) {
    let res: Response;
    try {
      // Signed URLs: never send Gauge credentials to the storage host.
      res = await fetch(file.url, { redirect: "follow" });
    } catch (error) {
      throw new CliError(
        "network",
        `Download of ${file.kind} failed: ${(error as Error).message}`,
      );
    }
    if (!res.ok)
      throw new CliError(
        "network",
        `Download of ${file.kind} failed: HTTP ${res.status}${res.status === 403 ? " (link expired; rerun `gauge chat exports get` for fresh links)" : ""}`,
      );
    const ext = extname(new URL(file.url).pathname) || ".csv";
    const path = resolve(join(dir, `${exp.id}-${file.kind}${ext}`));
    const body = Buffer.from(await res.arrayBuffer());
    writeFileSync(path, body);
    saved.push({ kind: file.kind, path, bytes: body.length });
  }
  return saved;
}

// The API generates an export when it is first requested, and again only when
// the same range is requested while the export is still incomplete 2 hours
// after creation or its last retry. Nothing retries on its own, and a failed
// export stays pending.
const EXPORT_RETRY_MS = 2 * 60 * 60 * 1000;

function retryCommand(exp: Export): string {
  return `gauge chat exports create --since ${exp.dateRange.since} --until ${exp.dateRange.until}`;
}

type ExportOpts = {
  wait?: boolean;
  download?: string;
  timeout: string;
  interval: string;
};

async function settle(
  scope: ChatScope,
  first: Export,
  opts: ExportOpts,
  cmd: Command,
): Promise<void> {
  const json = resolveOutput(cmd) === "json";
  const path = chatPath("orgs", scope.org, "exports", first.id);
  let exp = first;
  // Create responses omit the signed links; fetch them for a finished export.
  if (exp.status === "completed" && !exp.files?.length)
    exp = await scope.client.get<Export>(path);
  if (opts.wait || opts.download) {
    const deadline = Date.now() + seconds(opts.timeout, "--timeout") * 1000;
    const interval = seconds(opts.interval, "--interval") * 1000;
    while (exp.status !== "completed") {
      if (Date.now() >= deadline) {
        if (json) printJson(exp);
        throw new CliError(
          "internal",
          `wait_timeout: export ${exp.id} is still ${exp.status} after ${opts.timeout} s. Resume with \`gauge chat exports get ${exp.id} --wait\`.`,
          {
            apiCode: "wait_timeout",
            details: { id: exp.id, status: exp.status },
            hint: `If it is still pending 2 hours after it was created or last retried, retry it with \`${retryCommand(exp)}\`.`,
          },
        );
      }
      if (!json) console.error(`Export ${exp.id}: ${exp.status}…`);
      await new Promise((r) => setTimeout(r, interval));
      exp = await scope.client.get<Export>(path);
    }
  }
  const downloaded = opts.download
    ? await download(exp, opts.download)
    : undefined;
  if (json) return printJson(downloaded ? { ...exp, downloaded } : exp);
  console.log(
    `Export ${exp.id}: ${exp.status} (${exp.dateRange.since} to ${exp.dateRange.until})`,
  );
  if (
    exp.status === "pending" &&
    Date.now() - Date.parse(exp.createdAt) > EXPORT_RETRY_MS
  )
    console.error(
      `note: pending since ${exp.createdAt}. If it has stalled, \`${retryCommand(exp)}\` retries it (at most once every 2 hours).`,
    );
  if (downloaded)
    for (const file of downloaded)
      console.log(`${file.kind}: ${file.path} (${file.bytes} bytes)`);
  else
    for (const file of exp.files ?? [])
      console.log(`${file.kind}: ${file.url} (expires ${file.expiresAt})`);
}

function exportWaitOptions(command: Command): Command {
  return command
    .option("--wait", "poll (GET) until the export completes")
    .option("--download <dir>", "save the files into <dir> (implies --wait)")
    .option("--timeout <seconds>", "give up waiting after this long", "1800")
    .option("--interval <seconds>", "poll interval while waiting", "5");
}

export function registerData(chat: Command): void {
  const answers = chat
    .command("answers")
    .description("Sampled AI answers in a category");
  addPageOptions(
    rowFilters(
      withCategory(answers.command("list", { isDefault: true }))
        .description("List answers, newest first")
        .option(
          "--brand <ids>",
          "only answers mentioning any of these brd_ ids",
        )
        .option(
          "--brand-absent <ids>",
          "only answers mentioning none of these brd_ ids",
        ),
    ),
    MAX_ANSWER_LIMIT,
  ).action(async (opts: RowOpts, cmd: Command) => {
    const scope = await categoryScope(cmd);
    const page = await fetchPages<Answer>(
      scope.client,
      chatPath(...scope.base, "answers"),
      {
        ...rowQuery(opts),
        brand: list(opts.brand),
        brandAbsent: list(opts.brandAbsent),
      },
      opts,
      MAX_ANSWER_LIMIT,
    );
    printPage(page, resolveOutput(cmd), (a) => ({
      id: a.id,
      day: a.day,
      model: a.model,
      prompt: a.promptId,
      brands: a.brandIds.length,
      text: truncate(a.text, 60),
    }));
  });
  withCategory(answers.command("get <answer>"))
    .description(
      "Show an answer with its mentions, citations and search queries",
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const scope = await categoryScope(cmd);
      const answer = await scope.client.get<AnswerDetail>(
        chatPath(...scope.base, "answers", id),
      );
      if (resolveOutput(cmd) === "json") return printJson(answer);
      console.log(`${answer.id}  ${answer.model}  ${answer.day}`);
      console.log(`Prompt (${answer.promptId}): ${answer.promptText}\n`);
      console.log(`${answer.text}\n`);
      printItems(
        answer.mentions.map((m) => ({
          brand: m.brandId,
          name: m.name,
          count: m.count,
          types: m.mentionTypes.join(","),
        })),
        "table",
      );
      console.log("");
      printItems(
        answer.citations.map((c) => ({
          page: c.pageId,
          domain: c.domain,
          url: c.url,
        })),
        "table",
      );
      if (answer.searchQueries.length)
        console.log(`\nSearch queries: ${answer.searchQueries.join(" | ")}`);
    });

  const citations = chat
    .command("citations")
    .description("Pages cited by AI answers in a category");
  addPageOptions(
    rowFilters(
      withCategory(citations.command("list", { isDefault: true }))
        .description("List citations")
        .option("--domain <domains>", "comma-separated cited domains")
        .option("--page <ids>", "comma-separated pag_ ids"),
    ),
  ).action(async (opts: RowOpts, cmd: Command) => {
    const scope = await categoryScope(cmd);
    const page = await fetchPages<Citation>(
      scope.client,
      chatPath(...scope.base, "citations"),
      { ...rowQuery(opts), domain: list(opts.domain), page: list(opts.page) },
      opts,
    );
    printPage(page, resolveOutput(cmd), (c) => ({
      answer: c.answerId,
      day: c.day,
      model: c.model,
      domain: c.domain,
      url: c.url,
    }));
  });

  const exportsGroup = chat
    .command("exports")
    .description("Bulk CSV exports of answers and citations (all categories)");
  exportWaitOptions(
    exportsGroup
      .command("create")
      .description(
        "Start an export of past days (≤ 366 days); the same range returns the same export",
      )
      .requiredOption("--since <date>", "YYYY-MM-DD (inclusive)")
      .requiredOption(
        "--until <date>",
        "YYYY-MM-DD (inclusive; before today, Pacific time)",
      )
      .addHelpText(
        "after",
        `
An export is generated when it is first requested. Nothing retries on its own,
and a failed export stays pending: if it is still pending 2 hours after it was
created (or last retried), request the same range again to retry it. --wait and
--download poll with GET and never re-request. Export requests are limited to
10 per hour per token and organization.`,
      ),
  ).action(
    async (
      opts: ExportOpts & { since: string; until: string },
      cmd: Command,
    ) => {
      const scope = await chatScope(cmd);
      const exp = await scope.client.post<Export>(
        chatPath("orgs", scope.org, "exports"),
        {
          dateRange: { since: opts.since, until: opts.until },
        },
      );
      await settle(scope, exp, opts, cmd);
    },
  );
  exportWaitOptions(
    exportsGroup
      .command("get <export>")
      .description("Show an export and its signed download links"),
  ).action(async (id: string, opts: ExportOpts, cmd: Command) => {
    const scope = await chatScope(cmd);
    const exp = await scope.client.get<Export>(
      chatPath("orgs", scope.org, "exports", id),
    );
    await settle(scope, exp, opts, cmd);
  });
  exportsGroup
    .command("list")
    .description("The 20 most recent exports")
    .action(async (_opts: unknown, cmd: Command) => {
      const scope = await chatScope(cmd);
      const page = await scope.client.get<Page<Export>>(
        chatPath("orgs", scope.org, "exports"),
      );
      printPage(page, resolveOutput(cmd), (e) => ({
        id: e.id,
        status: e.status,
        since: e.dateRange.since,
        until: e.dateRange.until,
        createdAt: e.createdAt,
      }));
    });
}
