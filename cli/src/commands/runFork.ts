import { writeFileSync } from "node:fs";
import type { forks } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOutput } from "../lib/context";
import { printJson } from "../lib/output";
import {
  type PageView,
  parseEdits,
  parsePositiveSeq,
  printPageView,
  readJson,
  readText,
} from "./optimizations";

type ForkOpts = {
  before?: string;
  message?: string;
  page?: string;
  edits?: string;
  from?: string;
  contentType?: string;
};

function runPath(id: string): string {
  return `/api/v1/runs/${encodeURIComponent(id)}`;
}

function parseSeq(raw: string): number {
  const seq = parsePositiveSeq(raw);
  if (seq === null)
    throw new CliError("usage", `--before takes a seq, e.g. 34 (got ${raw})`);
  return seq;
}

export function forkBody(
  opts: ForkOpts,
  read: (path: string) => string = readText,
): forks.ForkRunBody {
  if (opts.page) {
    if (opts.before !== undefined || opts.message !== undefined)
      throw new CliError(
        "usage",
        "--page picks its own fork point; drop --before and --message",
      );
    if (!opts.edits === !opts.from)
      throw new CliError("usage", "--page needs --edits <file> or --from <file>");
    if (opts.contentType && !opts.from)
      throw new CliError("usage", "--content-type only applies with --from");
    return opts.edits
      ? {
          kind: "mock_page",
          url: opts.page,
          edits: parseEdits(readJson(opts.edits, read)),
        }
      : {
          kind: "mock_page",
          url: opts.page,
          body: read(opts.from as string),
          ...(opts.contentType ? { contentType: opts.contentType } : {}),
        };
  }
  if (opts.edits || opts.from || opts.contentType)
    throw new CliError("usage", "--edits, --from and --content-type need --page");
  if (!opts.before)
    throw new CliError("usage", "pass --before <seq>, or --page <url> with --edits or --from");
  const beforeSeq = parseSeq(opts.before);
  if (opts.message === undefined) return { kind: "run_again", beforeSeq };
  if (!opts.message.trim())
    throw new CliError("usage", "--message is empty");
  return { kind: "new_message", beforeSeq, message: opts.message };
}

function printFork(res: forks.ForkRunResponse): void {
  console.log(
    `Forked ${res.sourceRunId} before seq ${res.forkedBefore}: new run ${res.runId}`,
  );
  if (res.change) {
    const { linesBefore, linesAfter, retainedPercent, hunks } = res.change;
    console.log(
      `Mock ${res.mockId}: ${linesBefore} → ${linesAfter} lines, ${retainedPercent ?? "—"}% of the original kept`,
    );
    console.log(hunks);
  }
  console.log(`Follow with \`gauge run watch ${res.runId}\`.`);
}

export function registerRunFork(run: Command): void {
  hostedOnly(run.command("fork <runId>"))
    .description(
      "Start a new run that repeats a recorded run's steps up to a point, then continues live. Nothing else changes, unless you send a different persona message or mock a page the run read",
    )
    .option(
      "--before <seq>",
      "the first event that can change; the fork repeats every step before it",
    )
    .option(
      "--message <text>",
      "with --before at a persona message: send this message in its place",
    )
    .option(
      "--page <url>",
      "mock a page the run read; the fork starts at the last tool call before the run first read it",
    )
    .option(
      "--edits <file>",
      "with --page: JSON [{find, replace}] on the page's exact source; copy find text from `gauge run page --query`; '-' for stdin",
    )
    .option("--from <file>", "with --page: the complete new page; '-' for stdin")
    .option("--content-type <type>", "with --from: the page content type (default: keep)")
    .addHelpText(
      "after",
      `
Examples:
  gauge run fork <runId> --before 34
  gauge run fork <runId> --before 12 --message "Use the staging project instead"
  gauge run fork <runId> --page https://docs.example.com/start --edits edits.json

Find seqs with \`gauge run trace <runId> --seq <n>\` and the pages a run read with \`gauge run web <runId>\`.`,
    )
    .action(async (runId: string, opts: ForkOpts, command: Command) => {
      const res = await createClient().post<forks.ForkRunResponse>(
        `${runPath(runId)}/fork`,
        forkBody(opts),
      );
      if (resolveOutput(command) === "json") printJson(res);
      else printFork(res);
    });

  hostedOnly(run.command("page <runId> <url>"))
    .description(
      "Print a page as the run read it: the exact source (--text for readable text, --query for the source around a match)",
    )
    .option("--text", "readable text instead of the source")
    .option(
      "--query <text>",
      "the exact source around each match, to copy into `gauge run fork --edits`",
    )
    .option("--out <file>", "save the exact source to a file")
    .action(
      async (
        runId: string,
        url: string,
        opts: { text?: boolean; query?: string; out?: string },
        command: Command,
      ) => {
        if (opts.out && (opts.text || opts.query))
          throw new CliError("usage", "--out saves the exact source only");
        const view = await createClient().get<PageView>(
          `${runPath(runId)}/page`,
          {
            url,
            ...(opts.query ? { query: opts.query } : {}),
            ...(opts.text ? { view: "text" } : {}),
          },
        );
        if (opts.out) {
          if (view.raw === undefined)
            throw new CliError("internal", "The server returned no page source");
          if (view.raw.length < view.rawChars)
            throw new CliError(
              "internal",
              `The page has ${view.rawChars} chars, but the server returned only ${view.raw.length}`,
            );
          writeFileSync(opts.out, view.raw);
          console.error(`Saved ${opts.out}`);
        } else if (resolveOutput(command) === "json") printJson(view);
        else printPageView(view);
      },
    );
}
