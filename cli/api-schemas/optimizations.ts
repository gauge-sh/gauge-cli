import { z } from "zod";
import { cliRuleAuthorInputSchema, cliRuleBundleSchema } from "./cli-rules";
import { normalizeWebFixtureUrl } from "./web-page-identity";

export const OPTIMIZATION_STATUSES = ["OPEN", "DONE", "ARCHIVED"] as const;
export type OptimizationStatus = (typeof OPTIMIZATION_STATUSES)[number];

const skillPath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").some((p) => p === ".."),
    "Skill paths are relative and stay inside the skill",
  );

export const optimizationFileSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      url: z.url().transform(normalizeWebFixtureUrl),
      contentType: z.string().trim().min(1).default("text/html"),
      body: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("skill"),
      name: z.string().min(1),
      skillId: z.string().min(1).nullable().default(null),
      versionId: z.string().min(1).nullable().default(null),
      files: z.record(skillPath, z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cli"),
      package: z.string().min(1),
      rules: cliRuleBundleSchema,
    })
    .strict(),
]);
export type OptimizationFile = z.infer<typeof optimizationFileSchema>;

export const optimizationTreeSchema = z
  .object({ files: z.record(z.string().min(1), optimizationFileSchema) })
  .strict();
export type OptimizationTree = z.infer<typeof optimizationTreeSchema>;

export const EMPTY_TREE: OptimizationTree = { files: {} };

export function surfaceKey(
  file:
    | { kind: "page"; url: string }
    | { kind: "skill"; name: string }
    | { kind: "cli"; package: string },
): string {
  switch (file.kind) {
    case "page":
      return `page:${normalizeWebFixtureUrl(file.url)}`;
    case "skill":
      return `skill:${file.name}`;
    case "cli":
      return `cli:${file.package}`;
  }
}

export function surfaceLabel(file: OptimizationFile): string {
  switch (file.kind) {
    case "page":
      return file.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    case "skill":
      return file.name;
    case "cli":
      return file.package;
  }
}

export const optimizationSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("theme"),
      themeId: z.string().min(1),
      title: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("finding"),
      observationId: z.string().min(1),
      runId: z.string().min(1),
      label: z.string().min(1),
      detail: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("free"), text: z.string().min(1) }).strict(),
]);
export type OptimizationSubject = z.infer<typeof optimizationSubjectSchema>;

const findingRef = z
  .object({ runId: z.string().min(1), label: z.string().min(1) })
  .strict();

export const optimizationResultSchema = z
  .object({
    summary: z.string().min(1),
    changed: z.array(z.string().min(1)),
    resolved: z.array(findingRef),
    returned: z.array(findingRef),
    introduced: z.array(findingRef),
  })
  .strict();
export type OptimizationResult = z.infer<typeof optimizationResultSchema>;

export type TreeChange = {
  key: string;
  status: "added" | "changed" | "removed";
};

export function treeChanges(base: OptimizationTree, head: OptimizationTree) {
  const changes: TreeChange[] = [];
  for (const key of Object.keys(head.files)) {
    if (!(key in base.files)) changes.push({ key, status: "added" });
    else if (
      JSON.stringify(base.files[key]) !== JSON.stringify(head.files[key])
    )
      changes.push({ key, status: "changed" });
  }
  for (const key of Object.keys(base.files))
    if (!(key in head.files)) changes.push({ key, status: "removed" });
  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

// --- /api/v1 wire shapes ---------------------------------------------------

/** The API names a subject by id; the server reads its title, label, and detail. */
export const optimizationSubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue"), issueId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("finding"),
      observationId: z.string().min(1),
      runId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("free"), text: z.string().min(1) }).strict(),
]);
export type OptimizationSubjectRef = z.infer<
  typeof optimizationSubjectRefSchema
>;

/** The API calls a finding theme an issue. */
export type OptimizationWireSubject =
  | { kind: "issue"; issueId: string; title: string }
  | Exclude<OptimizationSubject, { kind: "theme" }>;

export type OptimizationWire<T extends { subject: OptimizationSubject }> = Omit<
  T,
  "subject"
> & { subject: OptimizationWireSubject };

export function toWireSubject(
  subject: OptimizationSubject,
): OptimizationWireSubject {
  return subject.kind === "theme"
    ? { kind: "issue", issueId: subject.themeId, title: subject.title }
    : subject;
}

export const createOptimizationBodySchema = z
  .object({
    subject: optimizationSubjectRefSchema,
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const patchOptimizationBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    notes: z.string().max(200_000).optional(),
    head: optimizationTreeSchema.optional(),
    status: z.enum(OPTIMIZATION_STATUSES).optional(),
  })
  .strict();

export const launchOptimizationBodySchema = z
  .object({
    runIds: z.array(z.string().min(1)).min(1).max(50).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const finishOptimizationBodySchema = optimizationResultSchema;

/** Authored CLI rules, or a bundle read back from the tree; the server seals them. */
export const cliRuleEditSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    bundleSha256: _digest,
    limits: _limits,
    ...authored
  } = value as Record<string, unknown>;
  return authored;
}, cliRuleAuthorInputSchema);

export const writeOptimizationFileBodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      url: z.url(),
      body: z.string().min(1),
      contentType: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("skill"),
      name: z.string().min(1),
      path: skillPath,
      body: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cli"),
      package: z.string().min(1),
      rules: cliRuleEditSchema,
    })
    .strict(),
]);
export type WriteOptimizationFileBody = z.infer<
  typeof writeOptimizationFileBodySchema
>;

export const addOptimizationFileBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), url: z.url() }).strict(),
  z.object({ kind: z.literal("skill"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("cli") }).strict(),
]);
export type AddOptimizationFileBody = z.infer<
  typeof addOptimizationFileBodySchema
>;

export const optimizationFileQuerySchema = z.object({
  key: z.string().min(1),
  /** Page only: readable text or the exact source; omit for the stored file. */
  view: z.enum(["text", "raw"]).optional(),
  /** Page only: the exact source around each match. */
  query: z.string().min(1).optional(),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(200_000).default(200_000),
});

/** Find/replace on a page's exact source; each find must match once. */
export const editOptimizationPageBodySchema = z
  .object({
    url: z.url(),
    edits: z
      .array(
        z.object({ find: z.string().min(1), replace: z.string() }).strict(),
      )
      .min(1),
  })
  .strict();
export type EditOptimizationPageBody = z.infer<
  typeof editOptimizationPageBodySchema
>;

/** What a page write or edit changed. */
export type OptimizationPageChange = {
  linesBefore: number;
  linesAfter: number;
  retainedPercent: number | null;
  hunks: string;
};

export const runTraceQuerySchema = z.object({
  seq: z.coerce.number().int().nonnegative(),
  before: z.coerce.number().int().nonnegative().max(200).default(30),
  after: z.coerce.number().int().nonnegative().max(200).default(10),
});

export const runCommandsQuerySchema = z.object({
  query: z.string().min(1).max(200).optional(),
  seq: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const listOptimizationsQuerySchema = z.object({
  status: z.enum(OPTIMIZATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const optimizationRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  agent: z.string(),
  model: z.string(),
  /** The eval or prompt name, else the prompt text. */
  title: z.string(),
  sourceRunId: z.string().nullable(),
  analyzed: z.boolean(),
  startedAt: z.string().nullable(),
});

export const optimizationLaunchSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  note: z.string().nullable(),
  sourceRunIds: z.array(z.string()),
  changed: z.array(z.string()),
  runs: z.array(optimizationRunSchema),
  createdAt: z.string(),
});
export type OptimizationLaunchView = z.infer<typeof optimizationLaunchSchema>;

const launchFindingSchema = z.object({
  label: z.string(),
  detail: z.string(),
  kind: z.string(),
  effect: z.string(),
  cause: z.string(),
  seqs: z.array(z.number()),
});

export const optimizationLaunchDetailSchema = optimizationLaunchSchema.extend({
  runs: z.array(
    optimizationRunSchema.extend({
      href: z.string(),
      findings: z.array(launchFindingSchema).nullable(),
      sourceFindings: z.array(launchFindingSchema),
    }),
  ),
});
export type OptimizationLaunchDetail = z.infer<
  typeof optimizationLaunchDetailSchema
>;

export const optimizationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(OPTIMIZATION_STATUSES),
  subject: optimizationSubjectSchema,
  launches: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OptimizationSummary = z.infer<typeof optimizationSummarySchema>;

/** The chat's optimization panel opens with its first change or rerun. */
export function optimizationHasWork(
  optimization: Pick<OptimizationSummary, "changed" | "launches">,
): boolean {
  return optimization.changed > 0 || optimization.launches > 0;
}

export const optimizationDetailSchema = optimizationSummarySchema.extend({
  notes: z.string(),
  base: optimizationTreeSchema,
  head: optimizationTreeSchema,
  changes: z.array(
    z.object({
      key: z.string(),
      status: z.enum(["added", "changed", "removed"]),
    }),
  ),
  result: optimizationResultSchema.nullable(),
  sourceRunIds: z.array(z.string()),
  launchList: z.array(optimizationLaunchSchema),
});
export type OptimizationDetail = z.infer<typeof optimizationDetailSchema>;

/** What the empty optimization chat shows before the first message. */
export type OptimizationBrief = {
  title: string;
  description: string | null;
  subjectKind: OptimizationSubject["kind"];
  /** The theme's or finding's kind; null for a goal, or a finding a reanalysis replaced. */
  kind: "FRICTION" | "OBJECTION" | "OPPORTUNITY" | null;
  /** The source sessions, in optimization order. */
  sessions: {
    runId: string;
    model: string;
    /** The catalog name, else the slug made readable. */
    modelName: string;
    title: string;
  }[];
  findings: number;
};
