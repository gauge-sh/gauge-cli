import type { query, stats } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { join } from "node:path";
import { CliError, createClient } from "../lib/client";
import { resolveOrg, resolveOutput } from "../lib/context";
import { gaugeState } from "../lib/gaugeState";
import { localQueryMetadata, queryLocal } from "../lib/localQuery";
import { searchLocalTranscripts } from "../lib/localSearch";
import { parseSince } from "../lib/localRuns";
import { printItems, printJson } from "../lib/output";

type QuerySpec = query.QuerySpecInput;
type WhereClause = query.WhereClause;

const collect = (value: string, prev: string[] = []): string[] => [
  ...prev,
  value,
];
const csv = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function parseWhere(expr: string): WhereClause {
  const inMatch = expr.match(/^\s*(\w+)\s+(in|contains)\s+(.*)$/i);
  if (inMatch) {
    const [, dimension, opRaw, rest] = inMatch;
    const op = opRaw.toLowerCase();
    if (op === "in") {
      return { dimension, op: "in", value: csv(rest) };
    }
    return { dimension, op: "contains", value: rest.trim() };
  }
  const opMatch = expr.match(/^\s*(\w+)\s*(!=|>=|<=|=|>|<)\s*(.*)$/);
  if (!opMatch) {
    throw new CliError(
      "usage",
      `Could not parse --where "${expr}". Use e.g. "action=install", "ecosystem in npm,pypi", or "name contains supa".`,
    );
  }
  const [, dimension, sym, rest] = opMatch;
  const opFor: Record<string, WhereClause["op"]> = {
    "=": "eq",
    "!=": "neq",
    ">": "gt",
    ">=": "gte",
    "<": "lt",
    "<=": "lte",
  };
  return { dimension, op: opFor[sym], value: rest.trim() };
}

export function parseOrderBy(raw: string): {
  key: string;
  dir: "asc" | "desc";
} {
  const [key, dir] = raw.split(":");
  if (
    !key.trim() ||
    (dir !== undefined && !["asc", "desc"].includes(dir.trim())) ||
    raw.split(":").length > 2
  )
    throw new CliError(
      "usage",
      `Invalid --order-by "${raw}". Use a selected field followed by :asc or :desc.`,
    );
  return { key: key.trim(), dir: dir?.trim() === "asc" ? "asc" : "desc" };
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
  prompt?: string;
  eval?: string;
  preference?: string;
  tag?: string;
  repo?: string;
  language?: string;
  framework?: string;
  size?: string;
  agent?: string;
  model?: string;
  scenario?: string;
  experiment?: string;
  branded?: boolean;
  unbranded?: boolean;
};

async function buildSpec(opts: QueryOpts): Promise<QuerySpec> {
  let spec: QuerySpec = { metrics: [] };
  if (opts.json) {
    const raw = opts.json === "-" ? await readStdin() : opts.json;
    try {
      spec = JSON.parse(raw) as QuerySpec;
    } catch (e) {
      throw new CliError(
        "usage",
        `--json is not valid JSON: ${(e as Error).message}`,
      );
    }
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw new CliError("usage", "--json must contain a query object.");

  if (opts.dataset) spec.dataset = opts.dataset as QuerySpec["dataset"];
  if (opts.dimensions !== undefined) spec.dimensions = csv(opts.dimensions);
  if (opts.metrics !== undefined) spec.metrics = csv(opts.metrics);
  if (opts.where?.length) spec.where = opts.where.map(parseWhere);
  if (opts.orderBy?.length) spec.orderBy = opts.orderBy.map(parseOrderBy);
  if (opts.limit !== undefined) spec.limit = Number(opts.limit);
  if (opts.granularity)
    spec.granularity = opts.granularity as QuerySpec["granularity"];
  if (opts.explain) spec.explain = true;

  const date: NonNullable<QuerySpec["dateRange"]> = {
    ...(spec.dateRange ?? {}),
  };
  if (opts.since) {
    date.since = opts.since;
    delete date.lastDays;
  } else if (opts.lastDays) {
    date.lastDays = Number(opts.lastDays);
    delete date.since;
  }
  if (opts.until) date.until = opts.until;
  if (Object.keys(date).length) spec.dateRange = date;

  if (opts.branded && opts.unbranded) {
    throw new CliError("usage", "Pass at most one of --branded / --unbranded.");
  }
  const filters: NonNullable<QuerySpec["filters"]> = {
    ...(spec.filters ?? {}),
  };
  if (opts.prompt) filters.prompt = opts.prompt;
  if (opts.eval) (filters as Record<string, unknown>).eval = csv(opts.eval);
  if (opts.preference) filters.visibilityPrompt = csv(opts.preference);
  if (opts.tag) filters.tag = csv(opts.tag);
  if (opts.repo) filters.repo = csv(opts.repo);
  if (opts.language) filters.language = csv(opts.language);
  if (opts.framework) filters.framework = csv(opts.framework);
  if (opts.size) filters.size = csv(opts.size);
  if (opts.agent) filters.agent = csv(opts.agent);
  if (opts.model) filters.model = csv(opts.model);
  if (opts.scenario) filters.scenario = csv(opts.scenario);
  if (opts.experiment) filters.experiment = csv(opts.experiment);
  if (opts.branded) filters.branded = true;
  if (opts.unbranded) filters.branded = false;
  if (Object.keys(filters).length) spec.filters = filters;

  if (!spec.metrics || spec.metrics.length === 0) {
    throw new CliError(
      "usage",
      "At least one metric is required. Pass --metrics <a,b> (or a `metrics` array in --json). See `gauge query fields --dataset <name>`.",
    );
  }
  return spec;
}

// Rate metrics are 0-1 fractions in both the Agents and Chat query APIs.
export const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function noteFreshness(f: stats.StatsFreshness): void {
  if (!f.available) {
    console.error(
      "warning: analytics store is temporarily unavailable; results may be incomplete.",
    );
  } else if (f.pending > 0) {
    console.error(
      `note: ${f.pending} recent run(s) still ingesting; results may not reflect them yet.`,
    );
  }
}

async function runQuery(command: Command, opts: QueryOpts): Promise<void> {
  const output = resolveOutput(command);
  const spec = await buildSpec(opts);
  const state = gaugeState(command);
  const res =
    state.mode === "local"
      ? queryLocal(localDirectory(command), spec)
      : await createClient().post<query.QueryResponse>(
          `/api/v1/orgs/${encodeURIComponent(await resolveOrg(command))}/query`,
          spec,
        );
  if (output === "json") {
    printJson(res);
    return;
  }
  if (res.sql) console.error(`\n${res.sql}\n`);
  const rateKeys = new Set(
    res.columns
      .filter((c) => c.kind === "metric" && c.key.endsWith("_rate"))
      .map((c) => c.key),
  );
  const rows = res.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of res.columns) {
      const v = row[col.key];
      out[col.key] =
        rateKeys.has(col.key) && typeof v === "number" ? pct(v) : v;
    }
    return out;
  });
  printItems(
    rows,
    "table",
    res.columns.map((c) => ({ key: c.key })),
  );
  noteFreshness(res.freshness);
  if ("analysisCoverage" in res && res.analysisCoverage) {
    const coverage = res.analysisCoverage as {
      sessions: number;
      analyzedSessions: number;
      unanalyzedSessions: number;
    };
    console.error(
      `Analysis coverage: ${coverage.analyzedSessions}/${coverage.sessions} selected sessions analyzed; ${coverage.unanalyzedSessions} unanalyzed.`,
    );
  }
}

async function showMetadata(
  command: Command,
  mode: "datasets" | "fields",
  dataset?: string,
): Promise<void> {
  const output = resolveOutput(command);
  const meta =
    gaugeState(command).mode === "local"
      ? localQueryMetadata()
      : await createClient().get<query.MetadataResponse>(
          `/api/v1/orgs/${encodeURIComponent(await resolveOrg(command))}/query/metadata`,
        );

  if (mode === "datasets") {
    if (output === "json")
      return printJson(
        meta.datasets.map((d) => ({ name: d.name, grain: d.grain })),
      );
    printItems(
      meta.datasets.map((d) => ({ dataset: d.name, grain: d.grain })),
      "table",
    );
    return;
  }

  const ds = meta.datasets.find((d) => d.name === dataset);
  if (!ds) {
    throw new CliError(
      "usage",
      `Unknown dataset "${dataset}". Valid: ${meta.datasets.map((d) => d.name).join(", ")}.`,
    );
  }
  if (output === "json") return printJson(ds);
  const rows = [
    ...ds.dimensions.map((f) => ({
      field: f.name,
      kind: "dimension",
      type: f.type,
      about: f.description ?? "",
    })),
    ...ds.metrics.map((f) => ({
      field: f.name,
      kind: "metric",
      type: f.type,
      about: f.description ?? "",
    })),
  ];
  console.error(`dataset: ${ds.name} — ${ds.grain}`);
  printItems(rows, "table");
}

export function register(program: Command): void {
  const group = program
    .command("query")
    .description(
      "Query local runs and findings or hosted analytics; discover backend capabilities",
    );

  group
    .command("run", { isDefault: true })
    .description(
      "Run a report; use query fields --dataset <name> with --local or --hosted to discover supported fields",
    )
    .option(
      "--json <spec>",
      "full query spec as JSON (or '-' to read stdin); flags override its keys",
    )
    .option(
      "--dataset <name>",
      "dataset name (local: runs | findings; use query datasets for hosted capabilities)",
    )
    .option("-d, --dimensions <names>", "comma-separated GROUP BY dimensions")
    .option("-m, --metrics <names>", "comma-separated metrics (at least one)")
    .option(
      "--where <expr>",
      'predicate, e.g. "action=install" (repeatable)',
      collect,
    )
    .option("--since <val>", "date range start — ISO date or window (30d, 24h)")
    .option("--until <val>", "date range end — ISO date or window")
    .option("--last-days <n>", "shorthand for --since <n> days ago")
    .option(
      "--order-by <key:dir>",
      "sort by a selected key, e.g. installs:desc (repeatable)",
      collect,
    )
    .option("--limit <n>", "max rows (default 50, max 1000)")
    .option(
      "--granularity <g>",
      "date bucket: day | week | month (default day)",
    )
    .option("--explain", "print the compiled SQL to stderr")
    .option("--prompt <id>", "filter to a single prompt")
    .option("--eval <ids>", "comma-separated saved eval IDs")
    .option("--preference <ids>", "comma-separated saved preference prompt IDs")
    .option("--tag <ids>", "comma-separated tag ids (hosted only)")
    .option("--repo <urls>", "comma-separated base repo urls (hosted only)")
    .option(
      "--language <langs>",
      "comma-separated repo languages (hosted only)",
    )
    .option(
      "--framework <names>",
      "comma-separated repo frameworks (hosted only)",
    )
    .option(
      "--size <buckets>",
      "comma-separated codebase-size buckets (hosted only)",
    )
    .option("--agent <names>", "comma-separated agent names")
    .option("--model <models>", "comma-separated models")
    .option(
      "--scenario <types>",
      "comma-separated scenario types (greenfield|migration; hosted only)",
    )
    .option(
      "--experiment <labels>",
      "comma-separated experiment labels (hosted only)",
    )
    .option("--branded", "only branded prompts (hosted only)")
    .option("--unbranded", "only non-branded prompts (hosted only)")
    .action((opts: QueryOpts, command: Command) => runQuery(command, opts));

  group
    .command("datasets")
    .description("List the datasets you can query")
    .action((_opts: unknown, command: Command) =>
      showMetadata(command, "datasets"),
    );

  group
    .command("fields")
    .description("List the dimensions and metrics for a dataset")
    .requiredOption("--dataset <name>", "dataset to describe")
    .action((opts: { dataset: string }, command: Command) =>
      showMetadata(command, "fields", opts.dataset),
    );

  group
    .command("search <text>")
    .description("Search local transcript evidence without building an index")
    .option("--eval <id>", "filter to a saved eval")
    .option("--preference <id>", "filter to a saved preference prompt")
    .option("--batch <id>", "filter to one launch batch")
    .option(
      "--since <value>",
      "session creation date or relative window, such as 7d",
    )
    .option(
      "--limit <n>",
      "maximum matching passages (default 50, maximum 1000)",
    )
    .action(
      async (
        text: string,
        opts: {
          eval?: string;
          preference?: string;
          batch?: string;
          since?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        if (gaugeState(command).mode !== "local")
          throw new CliError(
            "usage",
            "Transcript search is not supported by the hosted query backend. Use gauge run get <id> --logs --hosted to read a hosted transcript, or query search --local for local sessions.",
          );
        const result = await searchLocalTranscripts(
          localDirectory(command),
          text,
          {
            ...opts,
            since: opts.since ? parseSince(opts.since) : undefined,
            limit: opts.limit === undefined ? undefined : Number(opts.limit),
          },
        );
        if (resolveOutput(command) === "json") {
          printJson(result);
          return;
        }
        printItems(
          result.matches.map((match) => ({
            run: match.run,
            attempt: match.attempt,
            turn: match.turn,
            evidence: `${match.artifact}:${match.line}`,
            snippet: match.snippet,
          })),
          "table",
        );
        console.error(
          `Searched ${result.scannedSessions}/${result.selectedSessions} selected sessions.${result.truncated ? " More matches exist; narrow the cohort or increase --limit." : ""}${result.missingArtifacts.length ? ` Missing transcripts: ${result.missingArtifacts.join(", ")}.` : ""}`,
        );
      },
    );
}

function localDirectory(command: Command): string {
  const state = gaugeState(command);
  if (!state.root)
    throw new CliError(
      "usage",
      "No Gauge workspace found. Run gauge init --local in this directory first.",
    );
  return join(state.root, ".gauge");
}
