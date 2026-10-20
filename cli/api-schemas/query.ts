import { z } from "zod";
import { statsFreshnessSchema } from "./stats";

export const DATASETS = [
  "runs",
  "findings",
  "installs",
  "mentions",
  "web",
  "citations",
  "network",
  "files",
  "tokens",
  "brand_rollup",
] as const;
export const datasetSchema = z.enum(DATASETS);
export type Dataset = z.infer<typeof datasetSchema>;

export const WHERE_OPS = [
  "eq",
  "neq",
  "in",
  "notIn",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;
export const whereOpSchema = z.enum(WHERE_OPS);
export type WhereOp = z.infer<typeof whereOpSchema>;

export const GRANULARITIES = ["day", "week", "month"] as const;
export const granularitySchema = z.enum(GRANULARITIES);
export type Granularity = z.infer<typeof granularitySchema>;

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 1000;

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const whereClauseSchema = z.object({
  dimension: z.string().min(1),
  op: whereOpSchema,
  value: z.union([scalar, z.array(scalar)]),
});
export type WhereClause = z.infer<typeof whereClauseSchema>;

export const queryFiltersSchema = z
  .object({
    prompt: z.string(),
    eval: z.array(z.string()),
    visibilityPrompt: z.array(z.string()),
    preferenceOnly: z.boolean(),
    topic: z.array(z.string()),
    tag: z.array(z.string()),
    repo: z.array(z.string()),
    language: z.array(z.string()),
    framework: z.array(z.string()),
    size: z.array(z.string()),
    agent: z.array(z.string()),
    persona: z.array(z.string()),
    model: z.array(z.string()),
    scenario: z.array(z.string()),
    experiment: z.array(z.string()),
    branded: z.boolean(),
  })
  .partial();
export type QueryFilters = z.infer<typeof queryFiltersSchema>;

export const dateRangeSchema = z
  .object({
    since: z.string(),
    until: z.string(),
    lastDays: z.number().int().positive(),
  })
  .partial();
export type DateRange = z.infer<typeof dateRangeSchema>;

export const orderBySchema = z.object({
  key: z.string().min(1),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
export type OrderBy = z.infer<typeof orderBySchema>;

export const querySpecSchema = z.object({
  dataset: datasetSchema.default("runs"),
  dimensions: z.array(z.string()).default([]),
  metrics: z.array(z.string()).min(1, "at least one metric is required"),
  filters: queryFiltersSchema.default({}),
  where: z.array(whereClauseSchema).default([]),
  dateRange: dateRangeSchema.optional(),
  orderBy: z.array(orderBySchema).default([]),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUERY_LIMIT)
    .default(DEFAULT_QUERY_LIMIT),
  granularity: granularitySchema.default("day"),
  explain: z.boolean().default(false),
});
export type QuerySpec = z.infer<typeof querySpecSchema>;
export type QuerySpecInput = z.input<typeof querySpecSchema>;

export const columnKindSchema = z.enum(["dimension", "metric"]);
export const queryColumnSchema = z.object({
  key: z.string(),
  kind: columnKindSchema,
});
export type QueryColumn = z.infer<typeof queryColumnSchema>;

export const queryRowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type QueryRow = z.infer<typeof queryRowSchema>;

export const queryResponseSchema = z.object({
  columns: z.array(queryColumnSchema),
  rows: z.array(queryRowSchema),
  sql: z.string().optional(),
  freshness: statsFreshnessSchema,
  analysisCoverage: z
    .object({
      sessions: z.number().int().nonnegative(),
      analyzedSessions: z.number().int().nonnegative(),
      unanalyzedSessions: z.number().int().nonnegative(),
    })
    .optional(),
});
export type QueryResponse = z.infer<typeof queryResponseSchema>;

export const fieldTypeSchema = z.enum([
  "string",
  "number",
  "rate",
  "date",
  "boolean",
]);
export const fieldSchema = z.object({
  name: z.string(),
  type: fieldTypeSchema,
  description: z.string().optional(),
});
export type Field = z.infer<typeof fieldSchema>;

export const datasetMetaSchema = z.object({
  name: datasetSchema,
  grain: z.string(),
  dimensions: z.array(fieldSchema),
  metrics: z.array(fieldSchema),
});
export type DatasetMeta = z.infer<typeof datasetMetaSchema>;

export const metadataResponseSchema = z.object({
  datasets: z.array(datasetMetaSchema),
});
export type MetadataResponse = z.infer<typeof metadataResponseSchema>;
