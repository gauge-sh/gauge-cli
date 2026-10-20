import { z } from "zod";
import { candidateStartsSchema } from "./candidate-starts";
import { cliRuleBundleSchema } from "./cli-rules";
import {
  INTERVENTION_KINDS,
  LEVER_INTERVENTIONS,
  LEVER_KINDS,
} from "./climb-kinds";
import { agentConfigSchema, schedulableAgentSchema } from "./runConfig";
import {
  ecosystemSchema,
  overrideFilesSchema,
  sandboxOverridesSchema,
} from "./sandbox-overrides";
import { type WebFixture, webFixtureSchema } from "./web-fixtures";

export const climbSubjectKindSchema = z.enum(["EVAL_SET", "VISIBILITY_PROMPT"]);
export const leverKindSchema = z.enum(LEVER_KINDS);
export const interventionKindSchema = z.enum(INTERVENTION_KINDS);
const skill = z.object({ skillVersionId: z.string().min(1) }).strict();
const empty = z.object({}).strict();

function validateFixtureIntervention(
  value: Pick<WebFixture, "pages">,
  ctx: z.RefinementCtx,
) {
  const result = webFixtureSchema.safeParse({ version: 1, ...value });
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
  }
}

export const interventionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("BASELINE"), after: empty }),
  z.object({ kind: z.literal("ADD_SKILL"), after: skill }),
  z.object({ kind: z.literal("REMOVE_SKILL"), before: skill, after: empty }),
  z.object({ kind: z.literal("EDIT_SKILL"), before: skill, after: skill }),
  z.object({
    kind: z.literal("REWRITE_DOCS"),
    before: z.json().optional(),
    after: z
      .object({ pages: webFixtureSchema.shape.pages.unwrap().min(1) })
      .strict()
      .superRefine(validateFixtureIntervention),
  }),
  z.object({
    kind: z.literal("PACKAGE_VERSION"),
    after: z
      .object({
        ecosystem: ecosystemSchema,
        name: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
  }),
  z.object({
    kind: z.literal("PACKAGE_CONTENT"),
    after: z
      .object({
        ecosystem: ecosystemSchema,
        name: z.string().min(1),
        files: overrideFilesSchema,
      })
      .strict(),
  }),
  z.object({
    kind: z.literal("CLI_VERSION"),
    after: z
      .object({ name: z.string().min(1), version: z.string().min(1) })
      .strict(),
  }),
  z.object({
    kind: z.literal("CLI_INTERVENTION"),
    after: cliRuleBundleSchema,
  }),
]);
export type Intervention = z.infer<typeof interventionSchema>;
type Covered = Exclude<
  (typeof INTERVENTION_KINDS)[number],
  Intervention["kind"]
> extends never
  ? true
  : never;
export const interventionSchemaExhaustive: Covered = true;

export const climbSettingsSchema = z
  .object({
    maxRounds: z.number().int().positive().default(5),
    sampleCount: z.number().int().positive().default(1),
    creditCap: z.number().int().nonnegative(),
    targetScore: z.number().min(0).max(1).default(1),
    pinnedAgent: schedulableAgentSchema.optional(),
    pinnedModel: z.string().optional(),
    maxTrialsPerRound: z.number().int().min(1).max(10).default(3),
    continuedAtRound: z.number().int().nonnegative().optional(),
  })
  .strip()
  .refine((value) => value.pinnedAgent !== undefined || !value.pinnedModel, {
    path: ["pinnedAgent"],
    message: "Pin an agent with the model",
  });
export type ClimbSettings = z.infer<typeof climbSettingsSchema>;

export const climbDirectionSchema = z.object({
  focus: z.string().trim().max(2000).nullable().default(null),
  preserve: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  exclude: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  notes: z.string().trim().max(4000).nullable().default(null),
});
export type ClimbDirection = z.infer<typeof climbDirectionSchema>;

export const climbDirectionPatchSchema = z
  .object({
    focus: z.string().trim().max(2000).nullable().optional(),
    preserve: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    exclude: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    rationale: z.string().trim().max(500).optional(),
  })
  .strict();
export type ClimbDirectionPatch = z.infer<typeof climbDirectionPatchSchema>;

export const CLIMB_ACTIVITY_KINDS = [
  "STARTED",
  "PROPOSED",
  "EXCLUDED",
  "LAUNCHED",
  "SETTLED",
  "DONE",
  "FAILED",
  "DIRECTION",
  "PLAN",
  "MODE",
  "REPLAN",
  "ADOPTED",
  "AUTHORED",
  "CONTINUED",
  "CANCELED",
] as const;
export const climbActivityKindSchema = z.enum(CLIMB_ACTIVITY_KINDS);
export type ClimbActivityKind = z.infer<typeof climbActivityKindSchema>;

export const proposerTraceStepSchema = z.object({
  tool: z.string(),
  args: z.string(),
  result: z.string().nullable(),
  isError: z.boolean().optional(),
});
export const proposerTraceSchema = z.object({
  steps: z.array(proposerTraceStepSchema),
  reasoning: z.string(),
  durationMs: z.number().int().nonnegative(),
  model: z.string(),
});
export type ProposerTrace = z.infer<typeof proposerTraceSchema>;

export const climbActivitySchema = z.object({
  id: z.string(),
  climbId: z.string(),
  roundId: z.string().nullable(),
  trialId: z.string().nullable(),
  kind: climbActivityKindSchema,
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  summary: z.string(),
  detail: z.unknown().nullable(),
  createdAt: z.string(),
});
export type ClimbActivity = z.infer<typeof climbActivitySchema>;

export const activityQuerySchema = z.object({
  after: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

export function emptyClimbDirection(): ClimbDirection {
  return climbDirectionSchema.parse({});
}

export function directionIsEmpty(direction: ClimbDirection) {
  return (
    !direction.focus &&
    !direction.notes &&
    direction.preserve.length === 0 &&
    direction.exclude.length === 0
  );
}

export function targetExcluded(
  targetRef: unknown,
  exclude: readonly string[],
): boolean {
  if (!exclude.length) return false;
  const ref = targetRefSchema.safeParse(targetRef);
  if (!ref.success) return false;
  const exact = [ref.data.id, ref.data.url, ref.data.package].filter(
    (value): value is string => typeof value === "string",
  );
  const url = ref.data.url?.toLowerCase();
  return exclude.some((entry) => {
    const needle = entry.trim();
    if (!needle) return false;
    if (exact.includes(needle)) return true;
    return url?.includes(needle.toLowerCase()) ?? false;
  });
}

export const climbConfigSnapshotSchema = z
  .object({
    promptText: z.string(),
    scenario: z.enum(["GREENFIELD", "MIGRATION"]),
    repoUrl: z.string().nullable(),
    repoRef: z.string().nullable(),
    profileId: z.string().nullable(),
    profileName: z.string().nullable(),
    profileDescription: z.string().nullable(),
    profileModel: z.string().nullable(),
    limits: z.json(),
    agents: z.array(agentConfigSchema).min(1),
    skillRefs: z.array(z.string()),
    mcpRefs: z.array(z.string()),
    skillVersionIds: z.array(z.string()),
    mcpServerVersionIds: z.array(z.string()),
    skillSet: z.json().nullable(),
    mcpSet: z.json().nullable(),
    connectionIds: z.array(z.string()),
    connectionSet: z.json().nullable(),
    agentContext: z.json().nullable(),
    agentContextDigest: z.string().nullable(),
    webFixture: webFixtureSchema.nullable(),
    cliIntervention: cliRuleBundleSchema.nullable().default(null),
    sandboxOverrides: sandboxOverridesSchema.nullable(),
    visibilityScenarioId: z.string().nullable(),
  })
  .strict();
export type ClimbConfigSnapshot = z.infer<typeof climbConfigSnapshotSchema>;

export const targetRefSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().optional(),
    url: z.url().optional(),
    package: z.string().optional(),
  })
  .strict();

export const trialInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    hypothesis: z.string().max(4000).optional(),
    lever: leverKindSchema,
    targetRef: targetRefSchema.optional(),
    intervention: interventionSchema,
    authorMode: z.enum(["MANUAL", "DIRECT", "PROPOSE"]).default("MANUAL"),
    startingPoints: candidateStartsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const allowed: readonly string[] = LEVER_INTERVENTIONS[value.lever];
    if (!allowed.includes(value.intervention.kind))
      ctx.addIssue({
        code: "custom",
        path: ["intervention", "kind"],
        message: "This intervention does not change the selected lever",
      });
  });
export type TrialInput = z.infer<typeof trialInputSchema>;
