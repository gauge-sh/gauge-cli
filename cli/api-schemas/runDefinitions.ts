import { z } from "zod";
import { lifecycleSchema } from "./lifecycle";
import { preferenceDefinitionSchema } from "./preference";
import { runAddonsSchema } from "./runAddons";
import {
  agentConfigInputSchema,
  agentConfigSchema,
  assetRefListSchema,
} from "./runConfig";
import { runDefinitionInputSchema } from "./runDefinitionInputs";
import {
  inputPathSchema,
  inputUseSchema,
  runPlanResourceSchema,
} from "./runPlan";

export const inputUploadSpecSchema = z
  .object({
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
  })
  .strict();
export type InputUploadSpec = z.infer<typeof inputUploadSpecSchema>;
export type InputUploadResponse = {
  url: string;
  headers: Record<string, string>;
};

export const uncredentialedRepoUrlSchema = z
  .string()
  .min(1)
  .refine((raw) => {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return true;
    try {
      const url = new URL(raw);
      return (
        (url.protocol === "ssh:" || !url.username) &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Repository URL must not contain embedded credentials or query parameters");

export const runDefinitionChecksSchema = z
  .object({ paths: z.array(inputPathSchema).min(1).max(32) })
  .strict();

export const runDefinitionConfigSchema = z
  .object({
    agents: z.array(agentConfigInputSchema).min(1),
    sampleCount: z.number().int().min(1).max(50).optional(),
    repoUrl: uncredentialedRepoUrlSchema.nullable().optional(),
    repoRef: z.string().min(1).nullable().optional(),
    profileId: z.string().min(1).nullable().optional(),
    skillRefs: assetRefListSchema.optional(),
    mcpRefs: assetRefListSchema.optional(),
    connectionIds: z.array(z.string().min(1)).max(32).optional(),
    addons: runAddonsSchema.optional(),
    inputs: z.array(z.string()).optional(),
    checks: runDefinitionChecksSchema.optional(),
  })
  .strict();
export type RunDefinitionConfig = z.infer<typeof runDefinitionConfigSchema>;

export const runDefinitionFileConfigSchema = z
  .object({
    version: z.literal(2).default(2),
    org: z.string().min(1).optional(),
    orgId: z.string().uuid().optional(),
    checks: runDefinitionChecksSchema.optional(),
    cases: z
      .array(inputPathSchema)
      .min(1)
      .max(32)
      .default(["gauge-cases/**/*.md"]),
    inputs: z
      .record(
        z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(64),
        runDefinitionInputSchema,
      )
      .refine(
        (inputs) => Object.keys(inputs).length <= 32,
        "At most 32 inputs are allowed",
      )
      .meta({ maxProperties: 32 })
      .default({}),
  })
  .strict();

export const runDefinitionCriterionSchema = z
  .object({ name: z.string().min(1), rubric: z.string().min(1) })
  .strict();

const caseMeasurement = {
  criteria: z.array(runDefinitionCriterionSchema).min(1).optional(),
  preference: preferenceDefinitionSchema.optional(),
};
function exactlyOneMeasurement(item: {
  criteria?: unknown;
  preference?: unknown;
}) {
  return (item.criteria !== undefined) !== (item.preference !== undefined);
}

export const runDefinitionFrontmatterSchema = z
  .object({
    ...caseMeasurement,
    config: runDefinitionConfigSchema,
  })
  .strict()
  .refine(
    exactlyOneMeasurement,
    "Specify exactly one of criteria or preference",
  );

export const runDefinitionCaseSchema = z
  .object({
    path: z.string().min(1),
    prompt: z.string().min(1),
    ...caseMeasurement,
    config: runDefinitionConfigSchema,
  })
  .strict()
  .refine(
    exactlyOneMeasurement,
    "Specify exactly one of criteria or preference",
  );
export type RunDefinitionCase = z.infer<typeof runDefinitionCaseSchema>;

export const runDefinitionSubmissionSchema = z
  .object({
    version: z.literal(2),
    lifecycle: lifecycleSchema.nullish(),
    source: z
      .object({
        repoUrl: uncredentialedRepoUrlSchema.nullable(),
        commit: z
          .string()
          .regex(/^[a-f0-9]{40}$/i)
          .nullable(),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        verification: z.enum([
          "SUBMITTED_UNVERIFIED",
          "GITHUB_VERIFIED",
          "LOCAL",
        ]),
      })
      .strict(),
    resources: z.array(runPlanResourceSchema).max(32).default([]),
    cases: z.array(runDefinitionCaseSchema).min(1).max(20),
  })
  .strict()
  .superRefine((definition, ctx) => {
    if (
      definition.source.verification === "GITHUB_VERIFIED" &&
      definition.lifecycle !== undefined
    )
      ctx.addIssue({
        code: "custom",
        path: ["lifecycle"],
        message:
          "GitHub definitions cannot contain launch-only lifecycle scripts",
      });
    if (
      definition.source.verification !== "LOCAL" &&
      (!definition.source.repoUrl || !definition.source.commit)
    )
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "Committed definitions require a repository and commit",
      });
    if (
      definition.source.verification === "GITHUB_VERIFIED" &&
      definition.resources.some((r) => r.source.type === "upload")
    )
      ctx.addIssue({
        code: "custom",
        path: ["resources"],
        message: "GitHub definitions cannot contain uploaded inputs",
      });
    const paths = new Set<string>();
    for (const [index, item] of definition.cases.entries()) {
      if (paths.has(item.path))
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "path"],
          message: "Case paths must be unique",
        });
      paths.add(item.path);
    }
    const names = definition.resources.map((resource) => resource.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: "custom",
        path: ["resources"],
        message: "Input names must be unique",
      });
    for (const [index, item] of definition.cases.entries())
      for (const name of item.config.inputs ?? names)
        if (!names.includes(name))
          ctx.addIssue({
            code: "custom",
            path: ["cases", index, "config", "inputs"],
            message: `Unknown input: ${name}`,
          });
    for (const [index, resource] of definition.resources.entries()) {
      if (
        resource.source.repoUrl !== definition.source.repoUrl ||
        resource.source.commit !== definition.source.commit
      )
        ctx.addIssue({
          code: "custom",
          path: ["resources", index, "source"],
          message:
            "Project preparation must use the definition repository and commit",
        });
    }
  });
export type RunDefinitionSubmission = z.infer<
  typeof runDefinitionSubmissionSchema
>;

export const runDefinitionPublicSubmissionSchema =
  runDefinitionSubmissionSchema.refine(
    (definition) => definition.source.verification !== "GITHUB_VERIFIED",
    {
      path: ["source", "verification"],
      message: "Only the GitHub App may verify committed bytes",
    },
  );

export const runDefinitionPlanResponseSchema = z.object({
  source: runDefinitionSubmissionSchema.shape.source,
  lifecycle: z
    .object({
      setupTimeoutSeconds: z.number().int().min(1).max(600).optional(),
      teardownTimeoutSeconds: z.number().int().min(1).max(600).optional(),
    })
    .optional(),
  measurementMode: z.enum(["AGENT_EXPERIENCE", "AGENT_PREFERENCE", "MIXED"]),
  cases: z.array(
    z.object({
      path: z.string(),
      agents: z.array(agentConfigSchema),
      samples: z.number().int().nonnegative(),
      expectedRuns: z.number().int().nonnegative(),
      workspace: z.object({
        repoUrl: z.string().nullable(),
        repoRef: z.string().nullable(),
      }),
      criteriaCount: z.number().int().nonnegative(),
      preference: preferenceDefinitionSchema.optional(),
      inputs: z.array(z.string()),
    }),
  ),
  resources: z.array(
    z.object({
      name: z.string(),
      type: z.literal("input"),
      source: z.enum([
        "git",
        "github-actions",
        "github-deployment",
        "github-pr-comment",
        "upload",
      ]),
      use: inputUseSchema,
      readiness: z.enum(["READY", "WAITING", "FAILED"]),
      detail: z.string().optional(),
      commands: z.array(z.string()).optional(),
    }),
  ),
  expectedRuns: z.number().int().nonnegative(),
  canRun: z.boolean(),
});
export type RunDefinitionPlanResponse = z.infer<
  typeof runDefinitionPlanResponseSchema
>;

export const runDefinitionRunResponseSchema = z.object({
  runRequestId: z.string(),
  batchIds: z.array(z.string()),
  runIds: z.array(z.string()),
  requestedRuns: z.number().int().nonnegative(),
  createdRuns: z.number().int().nonnegative(),
  aggregateUrl: z.string(),
});
export type RunDefinitionRunResponse = z.infer<
  typeof runDefinitionRunResponseSchema
>;
