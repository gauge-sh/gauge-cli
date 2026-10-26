import { type Command, Option } from "commander";
import { CliError } from "../lib/client";
import {
  chatPath,
  chatScope,
  csv,
  resolveChatCategory,
  truncate,
  withCategory,
} from "../lib/chatApi";
import { resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";
import { noteFreshness, parseOrderBy, pct, readStdin } from "./query";

// Same envelope as the Agents query endpoint (gauge query), against Chat data.
export const CHAT_DATASETS = [
  "answers",
  "citations",
  "searchQueries",
  "aiTraffic",
] as const;
// Datasets scoped to the organization rather than a category.
const ORG_LEVEL_DATASETS = new Set(["aiTraffic"]);

type WhereOp = "eq" | "neq" | "in" | "notIn" | "contains";
type Where = { dimension: string; op: WhereOp; value: string | string[] };
type Filters = Record<string, unknown> & { category?: string };
export type ChatQuerySpec = {
  dataset?: string;
  dimensions?: string[];
  metrics?: string[];
  filters?: Filters;
  where?: Where[];
  dateRange?: { since?: string; until?: string; lastDays?: number };
  granularity?: string;
  orderBy?: { key: string; dir: "asc" | "desc" }[];
  limit?: number;
  explain?: boolean;
};

type Column = {
  key: string;
  kind: "dimension" | "metric";
  type: string;
  unit?: string | null;
};
type QueryResponse = {
  columns: Column[];
  rows: Record<string, unknown>[];
  labels: Record<string, Record<string, Record<string, unknown>>>;
  dateRange: { since: string; until: string };
  truncated: boolean;
  cached: boolean;
  freshness: { watermark: string | null; pending: number; available: boolean };
  sql?: string | null;
};

type FieldMeta = {
  name: string;
  type: string;
  description?: string;
  unit?: string | null;
  requires?: string[];
};
type DatasetMeta = {
  name: string;
  grain: string;
  description: string;
  requiresCategory: boolean;
  granularities: string[];
  dimensions: FieldMeta[];
  metrics: FieldMeta[];
  filters: string[];
  where: { name: string; ops: string[]; description: string }[];
};
type Metadata = {
  datasets: DatasetMeta[];
  limits: Record<string, number>;
  values: Record<string, unknown>;
};

export function parseChatWhere(expr: string): Where {
  const list = expr.match(/^\s*(\w+)\s+(not\s+in|in|contains)\s+(.*)$/i);
  if (list) {
    const [, dimension, rawOp, rest] = list;
    const op = rawOp.toLowerCase().replace(/\s+/, " ");
    if (op === "contains")
      return { dimension, op: "contains", value: rest.trim() };
    return { dimension, op: op === "in" ? "in" : "notIn", value: csv(rest) };
  }
  const cmp = expr.match(/^\s*(\w+)\s*(!=|=)\s*(.*)$/);
  if (!cmp)
    throw new CliError(
      "usage",
      `Could not parse --where "${expr}". Use e.g. "domain=example.com", "model in gpt-5,claude", "domain not in a.com,b.com", or "query contains pricing".`,
    );
  const [, dimension, sym, rest] = cmp;
  return { dimension, op: sym === "=" ? "eq" : "neq", value: rest.trim() };
}

type QueryOpts = {
  json?: string;
  dataset?: string;
  dimensions?: string;
  metrics?: string;
  where?: string[];
  since?: string;
  until?: string;
  lastDays?: string;
  orderBy?: string[];
  limit?: string;
  granularity?: string;
  explain?: boolean;
  brand?: string;
  model?: string;
  topic?: string;
  tag?: string;
  tagMode?: string;
  prompt?: string;
  trackingType?: string;
  domain?: string;
  page?: string;
};

const collect = (value: string, prev: string[] = []): string[] => [
  ...prev,
  value,
];

export async function buildChatSpec(opts: QueryOpts): Promise<ChatQuerySpec> {
  let spec: ChatQuerySpec = {};
  if (opts.json) {
    const raw = opts.json === "-" ? await readStdin() : opts.json;
    try {
      spec = JSON.parse(raw) as ChatQuerySpec;
    } catch (e) {
      throw new CliError(
        "usage",
        `--json is not valid JSON: ${(e as Error).message}`,
      );
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec))
      throw new CliError("usage", "--json must contain a query object.");
  }
  if (opts.dataset) spec.dataset = opts.dataset;
  if (opts.dimensions !== undefined) spec.dimensions = csv(opts.dimensions);
  if (opts.metrics !== undefined) spec.metrics = csv(opts.metrics);
  if (opts.where?.length) spec.where = opts.where.map(parseChatWhere);
  if (opts.orderBy?.length) spec.orderBy = opts.orderBy.map(parseOrderBy);
  if (opts.limit !== undefined) spec.limit = Number(opts.limit);
  if (opts.granularity) spec.granularity = opts.granularity;
  if (opts.explain) spec.explain = true;

  const date = { ...(spec.dateRange ?? {}) };
  if (opts.since) {
    date.since = opts.since;
    delete date.lastDays;
  } else if (opts.lastDays) {
    date.lastDays = Number(opts.lastDays);
    delete date.since;
  }
  if (opts.until) date.until = opts.until;
  if (Object.keys(date).length) spec.dateRange = date;

  const filters: Filters = { ...(spec.filters ?? {}) };
  for (const key of [
    "brand",
    "model",
    "topic",
    "tag",
    "prompt",
    "domain",
    "page",
  ] as const)
    if (opts[key]) filters[key] = csv(opts[key] as string);
  if (opts.tagMode) filters.tagMode = opts.tagMode;
  if (opts.trackingType) filters.trackingType = opts.trackingType;
  if (Object.keys(filters).length) spec.filters = filters;

  if (!spec.dataset)
    throw new CliError(
      "usage",
      `--dataset is required (${CHAT_DATASETS.join(", ")}). See \`gauge chat query datasets\`.`,
    );
  if (!spec.metrics?.length)
    throw new CliError(
      "usage",
      `At least one metric is required. Pass --metrics <a,b> (or a \`metrics\` array in --json). See \`gauge chat query fields --dataset ${spec.dataset}\`.`,
    );
  return spec;
}

function labelFor(
  labels: QueryResponse["labels"],
  type: string,
  value: unknown,
): unknown {
  if (!type.startsWith("id:") || typeof value !== "string") return value;
  const label = labels[type.slice(3)]?.[value];
  const text = label?.name ?? label?.title ?? label?.text ?? label?.url;
  return typeof text === "string" ? truncate(text, 60) : value;
}

async function runQuery(command: Command, opts: QueryOpts): Promise<void> {
  const spec = await buildChatSpec(opts);
  const { client, org, chatOrg } = await chatScope(command);
  const { category } = command.optsWithGlobals<{ category?: string }>();
  if (category) spec.filters = { ...(spec.filters ?? {}), category };
  else if (
    !ORG_LEVEL_DATASETS.has(spec.dataset as string) &&
    !spec.filters?.category
  )
    spec.filters = {
      ...(spec.filters ?? {}),
      category: await resolveChatCategory(command, client, chatOrg),
    };
  const res = await client.post<QueryResponse>(
    chatPath("orgs", org, "query"),
    spec,
  );
  if (resolveOutput(command) === "json") return printJson(res);
  if (res.sql) console.error(`\n${res.sql}\n`);
  printItems(
    res.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const col of res.columns) {
        const v = row[col.key];
        out[col.key] =
          col.kind === "dimension"
            ? labelFor(res.labels, col.type, v)
            : col.type === "rate" && typeof v === "number"
              ? pct(v)
              : v;
      }
      return out;
    }),
    "table",
    res.columns.map((c) => ({ key: c.key })),
  );
  console.error(`dateRange: ${res.dateRange.since} to ${res.dateRange.until}`);
  if (res.truncated)
    console.error("note: more rows exist; raise --limit or narrow the query.");
  noteFreshness(res.freshness);
}

async function metadata(command: Command, dataset?: string): Promise<Metadata> {
  const { client, org, chatOrg } = await chatScope(command);
  return client.get<Metadata>(chatPath("orgs", org, "query", "metadata"), {
    dataset,
  });
}

export function registerQuery(chat: Command): void {
  const group = chat
    .command("query")
    .description(
      "Query AI visibility data (answers, citations, searchQueries, aiTraffic)",
    );

  withCategory(group.command("run", { isDefault: true }))
    .description(
      "Run a query; discover fields with `gauge chat query fields --dataset <name>`",
    )
    .option(
      "--json <spec>",
      "full query spec as JSON (or '-' to read stdin); flags override its keys",
    )
    .option("--dataset <name>", CHAT_DATASETS.join(" | "))
    .option("-d, --dimensions <names>", "comma-separated GROUP BY dimensions")
    .option("-m, --metrics <names>", "comma-separated metrics (at least one)")
    .option(
      "--where <expr>",
      'predicate, e.g. "domain=example.com" or "model not in a,b" (repeatable)',
      collect,
    )
    .option("--since <val>", "date range start — YYYY-MM-DD or window (30d)")
    .option("--until <val>", "date range end — YYYY-MM-DD (inclusive)")
    .option("--last-days <n>", "shorthand for the last n days")
    .option(
      "--order-by <key:dir>",
      "sort by a selected key, e.g. visibility:desc (repeatable)",
      collect,
    )
    .option("--limit <n>", "max rows (default 50, max 1000)")
    .option(
      "--granularity <g>",
      "date bucket: hour (aiTraffic only, ≤ 14 days) | day | week | month (default day)",
    )
    // Gauge staff only (the API rejects it for everyone else), so hidden from help.
    .addOption(
      new Option("--explain", "print the compiled SQL to stderr").hideHelp(),
    )
    .option("--brand <ids>", "comma-separated brd_ ids")
    .option("--model <models>", "comma-separated models")
    .option("--topic <ids>", "comma-separated top_ ids")
    .option("--tag <ids>", "comma-separated tag_ ids")
    .option("--tag-mode <mode>", "any (default) | all")
    .option("--prompt <ids>", "comma-separated prm_ ids")
    .option(
      "--tracking-type <type>",
      "visibility (default) | branded_own | all",
    )
    .option("--domain <domains>", "comma-separated cited domains")
    .option("--page <ids>", "comma-separated pag_ ids")
    .addHelpText(
      "after",
      `
Answer datasets (answers, citations, searchQueries) are scoped to a category:
--category, else the chatCategory default, else the org's only category.
aiTraffic is organization-level; with --granularity hour its date column holds
UTC timestamps (YYYY-MM-DDTHH:MM:SSZ) instead of days. Rate metrics are 0-1
fractions (shown as percentages in tables).`,
    )
    .action((opts: QueryOpts, command: Command) => runQuery(command, opts));

  group
    .command("datasets")
    .description("List the datasets you can query")
    .action(async (_opts: unknown, command: Command) => {
      const meta = await metadata(command);
      const rows = meta.datasets.map((d) => ({
        name: d.name,
        grain: d.grain,
        requiresCategory: d.requiresCategory,
        description: d.description,
      }));
      if (resolveOutput(command) === "json") return printJson(rows);
      printItems(
        rows.map((r) => ({ ...r, description: truncate(r.description, 70) })),
        "table",
      );
    });

  group
    .command("fields")
    .description(
      "List the dimensions, metrics, filters and where columns for a dataset",
    )
    .requiredOption("--dataset <name>", "dataset to describe")
    .action(async (opts: { dataset: string }, command: Command) => {
      const meta = await metadata(command, opts.dataset);
      const ds = meta.datasets.find((d) => d.name === opts.dataset);
      if (!ds)
        throw new CliError(
          "usage",
          `Unknown dataset "${opts.dataset}". Valid: ${CHAT_DATASETS.join(", ")}.`,
        );
      if (resolveOutput(command) === "json") return printJson(ds);
      console.error(`dataset: ${ds.name} — ${ds.grain}. ${ds.description}`);
      printItems(
        [
          ...ds.dimensions.map((f) => ({
            field: f.name,
            kind: "dimension",
            type: f.type,
            about: f.description ?? "",
          })),
          ...ds.metrics.map((f) => ({
            field: f.name,
            kind: "metric",
            type: `${f.type}${f.unit ? ` (${f.unit})` : ""}`,
            about: `${f.description ?? ""}${f.requires?.length ? ` Needs ${f.requires.join(" or ")}.` : ""}`,
          })),
          ...ds.where.map((w) => ({
            field: w.name,
            kind: "where",
            type: w.ops.join("|"),
            about: w.description,
          })),
        ],
        "table",
      );
      console.error(
        `filters: ${ds.filters.join(", ") || "(none)"}; granularities: ${ds.granularities.join(", ")}`,
      );
    });

  group
    .command("metadata")
    .description(
      "Print the full query catalog with limits and this org's valid values (JSON)",
    )
    .option("--dataset <name>", "only this dataset")
    .action(async (opts: { dataset?: string }, command: Command) => {
      printJson(await metadata(command, opts.dataset));
    });
}
