import { z } from "zod";
import { targetRefSchema } from "./climb-kinds";

export const ANALYSIS_SCHEMA_VERSION = 1 as const;

const evidenceSequenceSchema = z.number().int().nonnegative().describe(
  "The event's recorded seq in this session attempt. Never infer it from an array index, line number, or turn.",
);

export const evidenceRefSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("trace"), seq: evidenceSequenceSchema })
    .strict(),
  z.object({ kind: z.literal("diff"), path: z.string().min(1) }).strict(),
]);
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const INSTALL_PHASES = [
  "NONE",
  "ATTEMPTED",
  "CONFIGURED",
  "EXERCISED",
] as const;

export const sessionProductSchema = z.object({
  name: z.string(),
  mentioned: z.boolean(),
  considered: z.boolean(),
  recommended: z.boolean(),
  chosen: z.boolean(),
  rejected: z.boolean(),
  abandoned: z.boolean(),
  installPhase: z.enum(INSTALL_PHASES),
  rank: z.number().int().nullable(),
  source: z.enum([
    "BRIEF",
    "PERSONA",
    "PRIOR",
    "SEARCH",
    "PAGE",
    "REPO",
    "UNKNOWN",
  ]),
  reason: z.string(),
  categories: z.array(z.string()),
  evidence: z.record(z.string(), z.array(evidenceRefSchema)),
});
export type SessionProduct = z.infer<typeof sessionProductSchema>;

export const SURFACE_LEVERS = [
  "DOCS",
  "MARKETING_SITE",
  "SKILL",
  "CLI",
] as const;
export const SURFACE_OWNERSHIPS = [
  "CATALOG",
  "INFERRED",
  "THIRD_PARTY",
] as const;

export const observationSurfaceSchema = z
  .object({
    lever: z.enum(SURFACE_LEVERS),
    evidenceSeq: z.number().int().nonnegative(),
    ownership: z.enum(SURFACE_OWNERSHIPS),
    target: targetRefSchema.nullish(),
    targetLabel: z.string().nullish(),
  })
  .strict();
export type ObservationSurface = z.infer<typeof observationSurfaceSchema>;

export const sessionObservationSchema = z.object({
  id: z.string(),
  kind: z.enum(["FRICTION", "OBJECTION", "OPPORTUNITY"]),
  label: z.string(),
  detail: z.string(),
  subject: z.string(),
  basis: z.enum(["OBSERVED", "AGENT_CLAIM", "INFERRED"]),
  effect: z.enum([
    "BLOCKED",
    "RECOVERED",
    "EXTRA_WORK",
    "SELECTION_LOSS",
    "UNKNOWN",
  ]),
  cause: z.enum([
    "PRODUCT",
    "CONTENT",
    "ACCESS",
    "ENVIRONMENT",
    "AGENT",
    "UNKNOWN",
  ]),
  tags: z.array(z.string()),
  evidence: z.array(evidenceRefSchema),
  surface: observationSurfaceSchema.nullable(),
});
export type SessionObservation = z.infer<typeof sessionObservationSchema>;

export const sessionAnalysisSchema = z.object({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  instructionsVersion: z.string().min(1),
  id: z.string(),
  runId: z.string(),
  attempt: z.number().int(),
  createdAt: z.string(),
  origin: z.enum(["MODEL", "LEGACY"]),
  model: z.string().nullable(),
  assessability: z.enum(["ASSESSED", "PARTIAL", "UNASSESSABLE"]),
  limitation: z.string().nullable(),
  selection: z.enum(["MEASURED", "UNASSESSABLE", "NOT_MEASURED"]),
  directed: z.boolean(),
  products: z.array(sessionProductSchema),
  observations: z.array(sessionObservationSchema),
});
export type SessionAnalysis = z.infer<typeof sessionAnalysisSchema>;

const artifactPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === ".." || part === ""),
    "Evidence paths must be relative paths inside the session artifacts",
  );

export const portableEvidenceRefSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("trace"), seq: evidenceSequenceSchema })
    .strict(),
  z.object({ kind: z.literal("diff"), path: artifactPathSchema }).strict(),
  z
    .object({
      kind: z.literal("artifact"),
      artifact: artifactPathSchema.describe(
        "Path relative to the session attempt directory, for example session/events.ndjson.",
      ),
      attempt: z.number().int().positive().optional().describe(
        "Must match the analysis attempt; defaults to that attempt.",
      ),
      line: z.number().int().positive().optional().describe(
        "One-based line number in the original artifact, before any filtering.",
      ),
      endLine: z.number().int().positive().optional().describe(
        "Inclusive last line of the evidence range.",
      ),
      seq: evidenceSequenceSchema.optional(),
    })
    .strict()
    .superRefine((ref, ctx) => {
      if (ref.line === undefined && ref.seq === undefined)
        ctx.addIssue({
          code: "custom",
          message: "Artifact evidence needs a line or seq",
        });
      if (
        ref.endLine !== undefined &&
        (ref.line === undefined || ref.endLine < ref.line)
      )
        ctx.addIssue({
          code: "custom",
          path: ["endLine"],
          message: "endLine requires line and must be at least line",
        });
    }),
]);
export type PortableEvidenceRef = z.infer<typeof portableEvidenceRefSchema>;

export const findingSubmissionSchema = sessionObservationSchema
  .omit({ id: true })
  .extend({
    label: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(10_000),
    subject: z.string().trim().min(1).max(200),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
    evidence: z.array(portableEvidenceRefSchema).min(1).max(100),
    surface: observationSurfaceSchema.nullable().default(null),
  })
  .strict();
export type FindingSubmission = z.infer<typeof findingSubmissionSchema>;

export const criterionAnalysisSubmissionSchema = z
  .object({
    criterionId: z.string().min(1),
    outcome: z.enum(["PASS", "FAIL", "UNASSESSABLE"]),
    label: z.string().trim().min(1).max(10_000),
    evidence: z.array(portableEvidenceRefSchema).max(100).default([]),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.outcome !== "UNASSESSABLE" && result.evidence.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A criterion verdict needs evidence",
      });
  });

const productSubmissionSchema = sessionProductSchema
  .extend({
    name: z.string().trim().min(1).max(200),
    evidence: z.record(z.string(), z.array(portableEvidenceRefSchema)),
  })
  .strict()
  .superRefine((product, ctx) => {
    if (
      (product.chosen || product.rejected || product.recommended) &&
      !product.considered
    )
      ctx.addIssue({
        code: "custom",
        path: ["considered"],
        message: "A chosen, rejected, or recommended product was considered",
      });
    if (product.considered && !product.mentioned)
      ctx.addIssue({
        code: "custom",
        path: ["mentioned"],
        message: "A considered product was mentioned",
      });
    if (!Object.values(product.evidence).some((refs) => refs.length > 0))
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A product judgment needs evidence",
      });
  });

export const analysisSubmissionSchema = z
  .object({
    schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
    attempt: z.number().int().positive().default(1),
    instructionsVersion: z.string().trim().min(1),
    analyst: z
      .object({
        name: z.string().trim().min(1),
        model: z.string().trim().min(1).optional(),
      })
      .strict(),
    assessability: sessionAnalysisSchema.shape.assessability,
    limitation: z.string().trim().min(1).nullable().default(null),
    selection: sessionAnalysisSchema.shape.selection.default("NOT_MEASURED"),
    directed: z.boolean().default(false),
    findings: z.array(findingSubmissionSchema).max(1000).default([]),
    products: z.array(productSubmissionSchema).max(1000).default([]),
    criteria: z.array(criterionAnalysisSubmissionSchema).max(1000).default([]),
  })
  .strict()
  .superRefine((analysis, ctx) => {
    for (const field of ["products", "criteria"] as const) {
      const keys =
        field === "products"
          ? analysis.products.map((product) => product.name.toLowerCase())
          : analysis.criteria.map((criterion) => criterion.criterionId);
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `Duplicate ${field} are not allowed`,
        });
    }
    if (analysis.assessability !== "ASSESSED" && analysis.limitation === null)
      ctx.addIssue({
        code: "custom",
        path: ["limitation"],
        message: "Partial or unassessable analysis needs a limitation",
      });
  });
export type AnalysisSubmission = z.infer<typeof analysisSubmissionSchema>;
