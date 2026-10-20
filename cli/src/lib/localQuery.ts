import type { SQLInputValue } from "node:sqlite";
import type { query } from "@withgauge/api-schemas";
import { ANALYSIS_SCHEMA_VERSION } from "@withgauge/api-schemas/sessionAnalysis";
import { CliError } from "./client";
import { openLocalStore } from "./localStore";

type FieldType = query.Field["type"];
type Dimension = { sql: string; type: FieldType; description: string };
type Metric = { sql: string; type: FieldType; description: string };
type Catalog = {
  name: "runs" | "findings";
  grain: string;
  from: string;
  dimensions: Record<string, Dimension>;
  metrics: Record<string, Metric>;
};
const dimension = (
  sql: string,
  description: string,
  type: FieldType = "string",
): Dimension => ({ sql, description, type });
const metric = (
  sql: string,
  description: string,
  type: FieldType = "number",
): Metric => ({ sql, description, type });

const common: Record<string, Dimension> = {
  run: dimension("s.id", "Session ID"),
  batch: dimension("s.batch_id", "Launch batch ID"),
  eval: dimension(
    "CASE WHEN s.measurement_kind = 'eval' THEN s.measurement_id END",
    "Saved eval ID",
  ),
  preference: dimension(
    "CASE WHEN s.measurement_kind = 'preference' THEN s.measurement_id END",
    "Saved preference prompt ID",
  ),
  measurement_revision: dimension(
    "s.measurement_revision",
    "Frozen measurement revision",
    "number",
  ),
  agent: dimension("s.agent", "Coding agent"),
  model: dimension("s.model", "Agent model"),
  date: dimension("date(s.created_at)", "Session creation date (UTC)", "date"),
};
const catalogs: Catalog[] = [
  {
    name: "runs",
    grain: "One local session (current attempt)",
    from: "sessions s",
    dimensions: {
      ...common,
      case: dimension("s.case_path", "File-based case path, when applicable"),
      outcome: dimension(
        "s.outcome",
        "Execution outcome; this is not an eval verdict",
      ),
      analyzed: dimension(
        "s.current_analysis_id IS NOT NULL",
        "Whether this attempt has published analysis",
        "boolean",
      ),
      analysis_id: dimension(
        "s.current_analysis_id",
        "Current published analysis ID",
      ),
    },
    metrics: {
      run_count: metric("COUNT(*)", "Number of sessions"),
      analyzed_runs: metric(
        "COALESCE(SUM(CASE WHEN s.current_analysis_id IS NOT NULL THEN 1 ELSE 0 END),0)",
        "Sessions with published analysis",
      ),
      avg_turns: metric(
        "AVG(s.turns)",
        "Average recorded turns; unknown values excluded",
      ),
      avg_duration_ms: metric(
        "AVG(s.duration_ms)",
        "Average recorded duration in milliseconds; unknown values excluded",
      ),
      input_tokens: metric(
        "SUM(s.input_tokens)",
        "Recorded input tokens; null when none have been recorded",
      ),
      output_tokens: metric(
        "SUM(s.output_tokens)",
        "Recorded output tokens; null when none have been recorded",
      ),
    },
  },
  {
    name: "findings",
    grain: "One finding in a session's current published analysis",
    from: "sessions s JOIN session_analyses a ON a.id = s.current_analysis_id JOIN session_findings f ON f.analysis_id = a.id",
    dimensions: {
      ...common,
      analysis_id: dimension("a.id", "Current published analysis ID"),
      kind: dimension("f.kind", "FRICTION, OBJECTION, or OPPORTUNITY"),
      subject: dimension("f.subject", "Product or surface discussed"),
      label: dimension(
        "f.label",
        "Finding title; matching labels do not imply a shared theme",
      ),
      basis: dimension("f.basis", "OBSERVED, AGENT_CLAIM, or INFERRED"),
      effect: dimension("f.effect", "Effect on the session"),
      cause: dimension("f.cause", "Attributed cause"),
    },
    metrics: {
      finding_count: metric(
        "COUNT(*)",
        "Findings in current published analyses",
      ),
      affected_runs: metric(
        "COUNT(DISTINCT s.id)",
        "Distinct sessions with matching findings",
      ),
    },
  },
];

export function localQueryMetadata(): query.MetadataResponse {
  return {
    datasets: catalogs.map((catalog) => ({
      name: catalog.name as query.Dataset,
      grain: catalog.grain,
      dimensions: Object.entries(catalog.dimensions).map(([name, field]) => ({
        name,
        type: field.type,
        description: field.description,
      })),
      metrics: Object.entries(catalog.metrics).map(([name, field]) => ({
        name,
        type: field.type,
        description: field.description,
      })),
    })),
  };
}

export type LocalQueryResponse = query.QueryResponse & {
  analysisCoverage: {
    sessions: number;
    analyzedSessions: number;
    unanalyzedSessions: number;
  };
};

export function queryLocal(
  gaugeDir: string,
  input: query.QuerySpecInput,
): LocalQueryResponse {
  const compiled = compileLocalQuery(input);
  const store = openLocalStore(gaugeDir);
  store.db.exec("BEGIN");
  try {
    if (compiled.catalog.name === "findings") {
      const versions = store.db
        .prepare(compiled.findingVersionsSql)
        .all(...compiled.coverageParams);
      const unsupported = versions.find(
        (row) => row.schema_version !== ANALYSIS_SCHEMA_VERSION,
      );
      if (unsupported)
        throw new CliError(
          "usage",
          `A selected session's analysis uses schema version ${unsupported.schema_version}; this CLI supports ${ANALYSIS_SCHEMA_VERSION}. Upgrade Gauge before querying these findings. Your data is intact.`,
        );
    }
    const rows = store.db
      .prepare(compiled.sql)
      .all(...compiled.params) as query.QueryRow[];
    for (const row of rows)
      for (const name of compiled.dimensions) {
        if (
          compiled.catalog.dimensions[name].type === "boolean" &&
          row[name] !== null
        )
          row[name] = Boolean(row[name]);
      }
    const coverage = store.db
      .prepare(compiled.coverageSql)
      .get(...compiled.coverageParams)!;
    const response: LocalQueryResponse = {
      columns: [
        ...compiled.dimensions.map((key) => ({
          key,
          kind: "dimension" as const,
        })),
        ...compiled.metrics.map((key) => ({ key, kind: "metric" as const })),
      ],
      rows,
      ...(input.explain ? { sql: compiled.sql } : {}),
      freshness: {
        available: true,
        pending: 0,
        watermark: coverage.watermark as string | null,
      },
      analysisCoverage: {
        sessions: Number(coverage.total),
        analyzedSessions: Number(coverage.analyzed),
        unanalyzedSessions: Number(coverage.total) - Number(coverage.analyzed),
      },
    };
    store.db.exec("COMMIT");
    return response;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  } finally {
    store.close();
  }
}

export function compileLocalQuery(input: query.QuerySpecInput): {
  sql: string;
  params: SQLInputValue[];
  coverageSql: string;
  coverageParams: SQLInputValue[];
  findingVersionsSql: string;
  catalog: Catalog;
  dimensions: string[];
  metrics: string[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CliError("usage", "A query must be a JSON object.");
  const topKeys = new Set([
    "dataset",
    "dimensions",
    "metrics",
    "filters",
    "where",
    "dateRange",
    "orderBy",
    "limit",
    "granularity",
    "explain",
  ]);
  for (const key of Object.keys(input))
    if (!topKeys.has(key))
      throw new CliError(
        "usage",
        `Unknown local query option "${key}". See gauge query fields --local --dataset runs.`,
      );
  const name = input.dataset ?? "runs";
  const catalog = catalogs.find((item) => item.name === name);
  if (!catalog)
    throw new CliError(
      "usage",
      `Dataset "${name}" is not supported by the local backend. Available: runs, findings.`,
      {
        hint: "Run gauge query datasets --local to discover local capabilities, or use --hosted for hosted datasets.",
      },
    );
  const dimensions = input.dimensions ?? [];
  const metrics = input.metrics;
  if (
    !Array.isArray(dimensions) ||
    dimensions.some((key) => typeof key !== "string")
  )
    throw new CliError(
      "usage",
      "Query dimensions must be an array of field names.",
    );
  if (
    !Array.isArray(metrics) ||
    metrics.length === 0 ||
    metrics.some((key) => typeof key !== "string")
  )
    throw new CliError("usage", "At least one metric is required.");
  if (
    new Set([...dimensions, ...metrics]).size !==
    dimensions.length + metrics.length
  )
    throw new CliError("usage", "Select each query field only once.");
  const unsupported = (kind: string, field: string): never => {
    throw new CliError(
      "usage",
      `${kind} "${field}" is not supported by the local ${name} dataset.`,
      {
        hint: `Run gauge query fields --dataset ${name} --local to discover supported fields; hosted capabilities may differ.`,
      },
    );
  };
  const granularity = input.granularity ?? "day";
  if (!["day", "week", "month"].includes(granularity))
    throw new CliError("usage", "Granularity must be day, week, or month.");
  const dateSql =
    granularity === "month"
      ? "date(s.created_at,'start of month')"
      : granularity === "week"
        ? "date(s.created_at,'-' || ((CAST(strftime('%w',s.created_at) AS INTEGER) + 6) % 7) || ' days')"
        : "date(s.created_at)";
  const expr = (key: string): string =>
    key === "date"
      ? dateSql
      : Object.hasOwn(catalog.dimensions, key)
        ? catalog.dimensions[key].sql
        : unsupported("Dimension", key);
  for (const key of dimensions) expr(key);
  for (const key of metrics)
    if (!Object.hasOwn(catalog.metrics, key)) unsupported("Metric", key);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new CliError(
      "usage",
      "Query limit must be an integer from 1 to 1000.",
    );
  const params: SQLInputValue[] = [];
  const predicates: string[] = [];
  const coveragePredicates: string[] = [];
  const coverageParams: SQLInputValue[] = [];
  const bind = (value: unknown): string => {
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      throw new CliError(
        "usage",
        "Query filter values must be strings, booleans, or finite numbers.",
      );
    params.push(
      typeof value === "boolean" ? Number(value) : (value as string | number),
    );
    return "?";
  };
  const where = input.where ?? [];
  if (!Array.isArray(where))
    throw new CliError("usage", "Query where must be an array of predicates.");
  for (const clause of where) {
    const paramStart = params.length;
    const predicateStart = predicates.length;
    if (
      !clause ||
      typeof clause !== "object" ||
      Object.keys(clause).some(
        (key) => !["dimension", "op", "value"].includes(key),
      )
    )
      throw new CliError(
        "usage",
        "Each where predicate requires dimension, op, and value.",
      );
    const sql = expr(clause.dimension);
    if (clause.op === "in" || clause.op === "notIn") {
      if (!Array.isArray(clause.value) || clause.value.length === 0)
        throw new CliError(
          "usage",
          `${clause.op} requires a nonempty value array.`,
        );
      predicates.push(
        `${sql} ${clause.op === "in" ? "IN" : "NOT IN"} (${clause.value.map(bind).join(",")})`,
      );
    } else {
      if (Array.isArray(clause.value))
        throw new CliError("usage", `${clause.op} requires a scalar value.`);
      if (clause.op === "contains") {
        if (typeof clause.value !== "string")
          throw new CliError("usage", "contains requires a string value.");
        predicates.push(
          `instr(lower(CAST(${sql} AS TEXT)),lower(${bind(clause.value)})) > 0`,
        );
      } else {
        const operators: Record<string, string> = {
          eq: "=",
          neq: "!=",
          gt: ">",
          gte: ">=",
          lt: "<",
          lte: "<=",
        };
        const op = operators[clause.op];
        if (!op)
          throw new CliError(
            "usage",
            `Unsupported filter operator "${clause.op}".`,
          );
        let value = clause.value;
        if (
          catalog.dimensions[clause.dimension].type === "number" &&
          typeof value === "string" &&
          value.trim() &&
          Number.isFinite(Number(value))
        )
          value = Number(value);
        if (
          catalog.dimensions[clause.dimension].type === "boolean" &&
          typeof value === "string" &&
          ["true", "false"].includes(value)
        )
          value = value === "true";
        predicates.push(`${sql} ${op} ${bind(value)}`);
      }
    }
    if (Object.hasOwn(common, clause.dimension) || name === "runs") {
      coveragePredicates.push(...predicates.slice(predicateStart));
      coverageParams.push(...params.slice(paramStart));
    }
  }
  const filterParamStart = params.length;
  const filterPredicateStart = predicates.length;
  const filters = input.filters ?? {};
  if (!filters || typeof filters !== "object" || Array.isArray(filters))
    throw new CliError("usage", "Query filters must be an object.");
  const supportedFilters: Record<string, string> = {
    agent: "s.agent",
    model: "s.model",
    prompt: "s.measurement_id",
    eval: "CASE WHEN s.measurement_kind = 'eval' THEN s.measurement_id END",
    visibilityPrompt:
      "CASE WHEN s.measurement_kind = 'preference' THEN s.measurement_id END",
  };
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(supportedFilters, key)) unsupported("Filter", key);
    const values = key === "prompt" ? [value] : value;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((item) => typeof item !== "string")
    )
      throw new CliError(
        "usage",
        `Filter ${key} requires ${key === "prompt" ? "a string" : "a nonempty array of strings"}.`,
      );
    predicates.push(
      `${supportedFilters[key]} IN (${values.map(bind).join(",")})`,
    );
  }
  const range = input.dateRange;
  if (range !== undefined) {
    if (!range || typeof range !== "object" || Array.isArray(range))
      throw new CliError("usage", "Query dateRange must be an object.");
    for (const key of Object.keys(range))
      if (!["since", "until", "lastDays"].includes(key))
        throw new CliError("usage", `Unknown dateRange field ${key}.`);
    if (range.since !== undefined && range.lastDays !== undefined)
      throw new CliError(
        "usage",
        "Use dateRange.since or dateRange.lastDays, not both.",
      );
    if (
      range.lastDays !== undefined &&
      (!Number.isInteger(range.lastDays) || range.lastDays <= 0)
    )
      throw new CliError("usage", "lastDays must be a positive integer.");
    const since =
      range.since !== undefined
        ? dateValue(range.since)
        : range.lastDays !== undefined
          ? new Date(Date.now() - range.lastDays * 86_400_000).toISOString()
          : null;
    const until = range.until !== undefined ? dateValue(range.until) : null;
    if (since && until && since > until)
      throw new CliError("usage", "Query since must be before until.");
    if (since)
      predicates.push(`julianday(s.created_at) >= julianday(${bind(since)})`);
    if (until)
      predicates.push(`julianday(s.created_at) <= julianday(${bind(until)})`);
  }
  coveragePredicates.push(...predicates.slice(filterPredicateStart));
  coverageParams.push(...params.slice(filterParamStart));
  const selected = new Set([...dimensions, ...metrics]);
  const order = input.orderBy ?? [];
  if (!Array.isArray(order))
    throw new CliError("usage", "Query orderBy must be an array.");
  for (const item of order) {
    if (!item || !selected.has(item.key))
      throw new CliError(
        "usage",
        `Order field "${item?.key}" must be one of the selected dimensions or metrics.`,
      );
    if (item.dir !== undefined && item.dir !== "asc" && item.dir !== "desc")
      throw new CliError("usage", "Order direction must be asc or desc.");
  }
  const columns = [
    ...dimensions.map((key) => `${expr(key)} AS "${key}"`),
    ...metrics.map((key) => `${catalog.metrics[key].sql} AS "${key}"`),
  ];
  const sql = `SELECT ${columns.join(", ")} FROM ${catalog.from}${predicates.length ? ` WHERE ${predicates.map((predicate) => `(${predicate})`).join(" AND ")}` : ""}${dimensions.length ? ` GROUP BY ${dimensions.map(expr).join(", ")}` : ""}${order.length ? ` ORDER BY ${order.map((item) => `"${item.key}" ${(item.dir ?? "desc").toUpperCase()}`).join(", ")}` : ""} LIMIT ${limit}`;
  const coverageWhere = coveragePredicates.length
    ? ` WHERE ${coveragePredicates.map((predicate) => `(${predicate})`).join(" AND ")}`
    : "";
  const coverageSql = `SELECT COUNT(*) AS total,COUNT(current_analysis_id) AS analyzed,MAX(COALESCE(ended_at,created_at)) AS watermark FROM sessions s${coverageWhere}`;
  const findingVersionsSql = `SELECT DISTINCT a.schema_version FROM sessions s JOIN session_analyses a ON a.id = s.current_analysis_id${coverageWhere}`;
  return {
    sql,
    params,
    coverageSql,
    coverageParams,
    findingVersionsSql,
    catalog,
    dimensions,
    metrics,
  };
}

function dateValue(value: string): string {
  if (typeof value !== "string")
    throw new CliError(
      "usage",
      "Date bounds must be ISO dates or relative windows such as 24h or 7d.",
    );
  const match = /^(\d+)([mhd])$/.exec(value.trim());
  const date = match
    ? new Date(
        Date.now() -
          Number(match[1]) *
            ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 0),
      )
    : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new CliError("usage", `Invalid date bound "${value}".`);
  return date.toISOString();
}
