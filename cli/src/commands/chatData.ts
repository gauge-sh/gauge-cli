import type { Command } from "commander";
import {
  addPageOptions,
  categoryScope,
  chatPath,
  csv,
  fetchPages,
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
}
