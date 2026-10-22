import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { CliError } from "../lib/client";
import {
  addPageOptions,
  type CategoryScope,
  CHAT_BATCH_SIZE,
  categoryScope,
  chatPath,
  chunks,
  csv,
  fetchPages,
  type PageOptions,
  printPage,
  resolveTagIds,
  resolveTopicId,
  truncate,
  withCategory,
} from "../lib/chatApi";
import { confirmOrAbort } from "../lib/confirm";
import { resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

type TrackingType = "visibility" | "branded_own";
const TRACKING_TYPES = ["visibility", "branded_own"] as const;

export type Prompt = {
  id: string;
  text: string;
  topicId: string | null;
  trackingType: string;
  tagIds: string[];
  createdAt: string;
  firstAnswerDay: string | null;
};

type CreateStatus = "created" | "already_exists" | "would_create";
type CreateResult = {
  index: number;
  status: CreateStatus;
  prompt?: Prompt | null;
};
type CreateResponse = {
  results: CreateResult[];
  dryRun: boolean;
  remaining: number | null;
};
type PromptIn = {
  text: string;
  topicId: string;
  trackingType?: TrackingType;
  tagIds?: string[];
};

// One prompt from args or a file, before topic and tag names are resolved.
export type RawPrompt = {
  text: string;
  topic?: string;
  trackingType?: string;
  tags?: string[];
};

const collect = (value: string, prev: string[] = []): string[] => [
  ...prev,
  ...csv(value),
];

function readSource(file: string): string {
  return readFileSync(file === "-" ? 0 : file, "utf8");
}

function fromJson(value: unknown, where: string): RawPrompt {
  if (typeof value === "string") return { text: value };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError(
      "usage",
      `${where}: expected a prompt string or an object with "text"`,
    );
  const item = value as Record<string, unknown>;
  if (typeof item.text !== "string")
    throw new CliError("usage", `${where}: "text" must be a string`);
  const topic = item.topicId ?? item.topic;
  const tags = item.tagIds ?? item.tags;
  if (topic !== undefined && typeof topic !== "string")
    throw new CliError("usage", `${where}: "topicId" must be a string`);
  if (
    tags !== undefined &&
    !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))
  )
    throw new CliError("usage", `${where}: "tagIds" must be a string array`);
  if (item.trackingType !== undefined && typeof item.trackingType !== "string")
    throw new CliError("usage", `${where}: "trackingType" must be a string`);
  return {
    text: item.text,
    topic,
    trackingType: item.trackingType as string | undefined,
    tags: tags as string[] | undefined,
  };
}

// A JSON array (strings or objects), or one prompt per line where a line that
// starts with "{" is a JSON object (JSON Lines). Blank lines are ignored.
export function parsePromptInput(content: string): RawPrompt[] {
  const trimmed = content.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new CliError(
        "usage",
        `prompt file is not valid JSON: ${(error as Error).message}`,
      );
    }
    return (parsed as unknown[]).map((item, i) => fromJson(item, `item ${i}`));
  }
  return content
    .split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), number: i + 1 }))
    .filter(({ line }) => line)
    .map(({ line, number }) => {
      if (!line.startsWith("{")) return { text: line };
      try {
        return fromJson(JSON.parse(line), `line ${number}`);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(
          "usage",
          `line ${number} is not valid JSON: ${(error as Error).message}`,
        );
      }
    });
}

function trackingType(value: string | undefined): TrackingType | undefined {
  if (value === undefined) return undefined;
  if ((TRACKING_TYPES as readonly string[]).includes(value))
    return value as TrackingType;
  throw new CliError(
    "usage",
    `trackingType must be one of ${TRACKING_TYPES.join(", ")} (got "${value}")`,
  );
}

async function resolvePrompts(
  scope: CategoryScope,
  raw: RawPrompt[],
  defaults: { topic?: string; trackingType?: string; tags: string[] },
): Promise<PromptIn[]> {
  const topics = new Map<string, string>();
  for (const [i, item] of raw.entries()) {
    const topic = item.topic ?? defaults.topic;
    if (!topic)
      throw new CliError(
        "usage",
        `prompt ${i} has no topic. Pass --topic <id|slug|title> or set "topicId" per item.`,
      );
    if (!topics.has(topic))
      topics.set(topic, await resolveTopicId(scope, topic));
  }
  const tagNames = [
    ...new Set([...defaults.tags, ...raw.flatMap((item) => item.tags ?? [])]),
  ];
  const tagIds = new Map<string, string>();
  const resolved = await resolveTagIds(scope, tagNames);
  tagNames.forEach((name, i) => tagIds.set(name, resolved[i]));
  return raw.map((item) => {
    const tags = [...new Set([...defaults.tags, ...(item.tags ?? [])])];
    const type = trackingType(item.trackingType ?? defaults.trackingType);
    return {
      text: item.text,
      topicId: topics.get((item.topic ?? defaults.topic) as string) as string,
      ...(type ? { trackingType: type } : {}),
      ...(tags.length
        ? { tagIds: tags.map((t) => tagIds.get(t) as string) }
        : {}),
    };
  });
}

const normalized = (text: string) =>
  text.trim().toLowerCase().replace(/\s+/g, " ");

export type AddOutcome = {
  results: Array<{
    index: number;
    status: CreateStatus;
    id: string | null;
    text: string;
    prompt: Prompt | null;
  }>;
  dryRun: boolean;
  remaining: number | null;
  summary: Record<CreateStatus, number>;
};

function outcome(
  prompts: PromptIn[],
  responses: CreateResponse[],
  dryRun: boolean,
): AddOutcome {
  const results = responses.flatMap((response, chunk) =>
    response.results.map((r) => {
      const index = chunk * CHAT_BATCH_SIZE + r.index;
      return {
        index,
        status: r.status,
        id: r.prompt?.id ?? null,
        text: prompts[index].text,
        prompt: r.prompt ?? null,
      };
    }),
  );
  const summary = { created: 0, already_exists: 0, would_create: 0 };
  for (const r of results) summary[r.status]++;
  return {
    results,
    dryRun,
    remaining: responses.at(-1)?.remaining ?? null,
    summary,
  };
}

function printOutcome(result: AddOutcome, cmd: Command): void {
  if (resolveOutput(cmd) === "json") return printJson(result);
  printItems(
    result.results.map((r) => ({
      index: r.index,
      status: r.status,
      id: r.id,
      text: truncate(r.text, 70),
    })),
    "table",
  );
  const { created, already_exists, would_create } = result.summary;
  console.error(
    `${result.dryRun ? "dry run: " : ""}${result.dryRun ? `${would_create} would be created` : `${created} created`}, ${already_exists} already existed${result.remaining === null ? "" : `; plan allows ${result.remaining} more`}.`,
  );
}

// Create prompts in ≤500-item requests. A multi-request write is preceded by a
// dry run of every chunk, so validation errors and plan limits fail before
// anything is created. Creation is idempotent per text, so rerunning after a
// partial failure is safe.
export async function addPrompts(
  scope: CategoryScope,
  prompts: PromptIn[],
  dryRun: boolean,
  onPartial?: (partial: AddOutcome) => void,
): Promise<AddOutcome> {
  const path = chatPath(...scope.base, "prompts");
  const batches = chunks(prompts);
  const send = (batch: PromptIn[], dry: boolean) =>
    scope.client.post<CreateResponse>(
      path,
      { prompts: batch },
      {
        dryRun: dry || undefined,
      },
    );
  if (!dryRun && batches.length > 1) {
    const preview: CreateResponse[] = [];
    for (const batch of batches) preview.push(await send(batch, true));
    const fresh = new Set<string>();
    preview.forEach((response, chunk) => {
      for (const r of response.results)
        if (r.status === "would_create")
          fresh.add(
            normalized(prompts[chunk * CHAT_BATCH_SIZE + r.index].text),
          );
    });
    const remaining = preview[0]?.remaining ?? null;
    if (remaining !== null && fresh.size > remaining)
      throw new CliError(
        "insufficient_credits",
        `limit_exceeded: ${fresh.size} new prompts exceed the ${remaining} your plan allows; nothing was created.`,
        {
          apiCode: "limit_exceeded",
          details: { remaining, wouldCreate: fresh.size },
        },
      );
  }
  const responses: CreateResponse[] = [];
  for (const batch of batches) {
    try {
      responses.push(await send(batch, dryRun));
    } catch (error) {
      if (responses.length && onPartial)
        onPartial(outcome(prompts, responses, dryRun));
      if (responses.length && error instanceof CliError)
        throw new CliError(
          error.code,
          `${error.message} — the first ${responses.length * CHAT_BATCH_SIZE} prompts were already submitted; rerunning is safe (existing prompts report already_exists).`,
          { apiCode: error.apiCode, details: error.details, hint: error.hint },
        );
      throw error;
    }
  }
  return outcome(prompts, responses, dryRun);
}

function readIds(args: string[], file?: string): string[] {
  const ids = [
    ...args,
    ...(file
      ? readSource(file)
          .split(/[\s,]+/)
          .filter(Boolean)
      : []),
  ];
  if (!ids.length)
    throw new CliError("usage", "pass prompt ids as arguments or with --file");
  return [...new Set(ids)];
}

type PromptListOpts = PageOptions & {
  topic?: string;
  tag?: string[];
  trackingType?: string;
};

export function registerPrompts(chat: Command): void {
  const prompts = chat
    .command("prompts")
    .description("Tracked prompts in a category");

  addPageOptions(
    withCategory(prompts.command("list", { isDefault: true }))
      .description("List prompts")
      .option("--topic <topic>", "only this topic (id, slug, or title)")
      .option(
        "--tag <tags>",
        "only prompts with any of these tags (ids or names)",
        collect,
      )
      .option(
        "--tracking-type <type>",
        "visibility | branded_own | all (default all)",
      ),
  ).action(async (opts: PromptListOpts, cmd: Command) => {
    const scope = await categoryScope(cmd);
    const page = await fetchPages<Prompt>(
      scope.client,
      chatPath(...scope.base, "prompts"),
      {
        topic: opts.topic ? await resolveTopicId(scope, opts.topic) : undefined,
        tag: opts.tag?.length
          ? await resolveTagIds(scope, opts.tag)
          : undefined,
        trackingType: opts.trackingType,
      },
      opts,
    );
    printPage(page, resolveOutput(cmd), (p) => ({
      id: p.id,
      topic: p.topicId,
      type: p.trackingType,
      tags: p.tagIds.join(","),
      firstAnswer: p.firstAnswerDay,
      text: truncate(p.text, 70),
    }));
  });

  withCategory(prompts.command("add [texts...]"))
    .description(
      "Add prompts from arguments or --file (one per line, JSON Lines, or a JSON array); existing texts report already_exists",
    )
    .option(
      "--topic <topic>",
      "topic for items without their own (id, slug, or title)",
    )
    .option("-f, --file <path>", "read prompts from a file ('-' for stdin)")
    .option(
      "--tag <tags>",
      "tags for every prompt (ids or names; repeatable)",
      collect,
    )
    .option(
      "--tracking-type <type>",
      "visibility (default) | branded_own, for items without their own",
    )
    .option("--dry-run", "report what would be created without creating")
    .addHelpText(
      "after",
      `
Items in a file may be strings or objects:
  {"text": "...", "topicId": "top_1…", "trackingType": "visibility", "tagIds": ["tag_1…"]}
Inputs over ${CHAT_BATCH_SIZE} prompts are sent in chunks after a dry run of every chunk.
Each item reports created, already_exists, or would_create (with --dry-run).`,
    )
    .action(
      async (
        texts: string[],
        opts: {
          topic?: string;
          file?: string;
          tag?: string[];
          trackingType?: string;
          dryRun?: boolean;
        },
        cmd: Command,
      ) => {
        const raw: RawPrompt[] = [
          ...texts.map((text) => ({ text })),
          ...(opts.file ? parsePromptInput(readSource(opts.file)) : []),
        ];
        if (!raw.length)
          throw new CliError(
            "usage",
            "no prompts given; pass them as arguments or with --file",
          );
        const scope = await categoryScope(cmd);
        const resolved = await resolvePrompts(scope, raw, {
          topic: opts.topic,
          trackingType: opts.trackingType,
          tags: opts.tag ?? [],
        });
        const result = await addPrompts(
          scope,
          resolved,
          opts.dryRun ?? false,
          (partial) => printOutcome(partial, cmd),
        );
        printOutcome(result, cmd);
      },
    );

  withCategory(prompts.command("move <prompts...>"))
    .description("Move prompts to another topic")
    .requiredOption("--topic <topic>", "destination topic (id, slug, or title)")
    .action(async (ids: string[], opts: { topic: string }, cmd: Command) => {
      const scope = await categoryScope(cmd);
      const topicId = await resolveTopicId(scope, opts.topic);
      const moved: Prompt[] = [];
      for (const id of new Set(ids))
        moved.push(
          await scope.client.patch<Prompt>(
            chatPath(...scope.base, "prompts", id),
            { topicId },
          ),
        );
      if (resolveOutput(cmd) === "json") return printJson({ data: moved });
      console.log(`Moved ${moved.length} prompt(s) to ${topicId}`);
    });

  withCategory(prompts.command("delete [prompts...]"))
    .alias("rm")
    .description(
      "Delete prompts (ids as arguments or --file); answers are removed in the background",
    )
    .option("-f, --file <path>", "read prompt ids from a file ('-' for stdin)")
    .option("--dry-run", "report what would be deleted")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(
      async (
        args: string[],
        opts: { file?: string; dryRun?: boolean; yes?: boolean },
        cmd: Command,
      ) => {
        const ids = readIds(args, opts.file);
        const scope = await categoryScope(cmd);
        if (!opts.dryRun)
          await confirmOrAbort(`Delete ${ids.length} prompt(s)?`, opts.yes);
        const deleted: string[] = [];
        const notFound: string[] = [];
        for (const batch of chunks(ids)) {
          const res = await scope.client.delete<{
            deleted: string[];
            notFound: string[];
          }>(
            chatPath(...scope.base, "prompts"),
            { dryRun: opts.dryRun || undefined },
            { ids: batch },
          );
          deleted.push(...res.deleted);
          notFound.push(...res.notFound);
        }
        const result = { deleted, notFound, dryRun: opts.dryRun ?? false };
        if (resolveOutput(cmd) === "json") return printJson(result);
        console.log(
          `${opts.dryRun ? "Would delete" : "Deleted"} ${deleted.length} prompt(s)${notFound.length ? `; not found: ${notFound.join(", ")}` : ""}`,
        );
      },
    );

  for (const [name, method, verb] of [
    ["tag", "post", "Tagged"],
    ["untag", "delete", "Untagged"],
  ] as const)
    withCategory(prompts.command(`${name} [prompts...]`))
      .description(
        `${name === "tag" ? "Apply" : "Remove"} tags ${name === "tag" ? "to" : "from"} prompts (ids as arguments or --file)`,
      )
      .requiredOption(
        "--tag <tags>",
        "tag ids or names (comma-separated or repeatable)",
        collect,
      )
      .option(
        "-f, --file <path>",
        "read prompt ids from a file ('-' for stdin)",
      )
      .action(
        async (
          args: string[],
          opts: { tag: string[]; file?: string },
          cmd: Command,
        ) => {
          const ids = readIds(args, opts.file);
          const scope = await categoryScope(cmd);
          const tagIds = await resolveTagIds(scope, opts.tag);
          const path = chatPath(...scope.base, "prompts", "tags");
          const promptIds: string[] = [];
          for (const batch of chunks(ids)) {
            const body = { promptIds: batch, tagIds };
            const res =
              method === "post"
                ? await scope.client.post<{ promptIds: string[] }>(path, body)
                : await scope.client.delete<{ promptIds: string[] }>(
                    path,
                    undefined,
                    body,
                  );
            promptIds.push(...res.promptIds);
          }
          if (resolveOutput(cmd) === "json")
            return printJson({ promptIds, tagIds });
          console.log(
            `${verb} ${promptIds.length} prompt(s) with ${tagIds.join(", ")}`,
          );
        },
      );
}
