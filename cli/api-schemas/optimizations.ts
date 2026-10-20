import { z } from "zod";
import { candidateDeliverySchema } from "./candidate-delivery";
import { candidateStartsSchema } from "./candidate-starts";
import { cliRuleCoverageSchema } from "./cli-rule-evidence";
import {
  climbDirectionPatchSchema,
  climbDirectionSchema,
  climbSubjectKindSchema,
  interventionKindSchema,
  leverKindSchema,
  trialInputSchema,
} from "./climb";
import { schedulableAgentSchema } from "./runConfig";
import { overrideFilesSchema } from "./sandbox-overrides";

export const OPTIMIZATION_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "DONE",
  "ARCHIVED",
] as const;
export const optimizationStatusSchema = z.enum(OPTIMIZATION_STATUSES);
export type OptimizationStatus = z.infer<typeof optimizationStatusSchema>;

export const TERMINAL_OPTIMIZATION_STATUSES = ["DONE", "ARCHIVED"] as const;

export const ROUND_STATUSES = [
  "PROPOSING",
  "PROPOSED",
  "RUNNING",
  "JUDGING",
  "SETTLED",
  "FAILED",
  "CANCELED",
] as const;
export const TRIAL_STATUSES = [
  "DRAFT",
  "RUNNING",
  "SETTLED",
  "FAILED",
  "CANCELED",
] as const;
export const TRIAL_VERDICTS = [
  "BETTER",
  "WORSE",
  "INCONCLUSIVE",
  "NOT_EVALUABLE",
] as const;

export const OPTIMIZATION_EFFORTS = [
  { value: "LOW", label: "Quick", sampleCount: 1, maxRounds: 3 },
  { value: "MEDIUM", label: "Standard", sampleCount: 1, maxRounds: 5 },
  { value: "HIGH", label: "Thorough", sampleCount: 2, maxRounds: 8 },
  { value: "XHIGH", label: "Exhaustive", sampleCount: 3, maxRounds: 12 },
] as const;
export type OptimizationEffort = (typeof OPTIMIZATION_EFFORTS)[number]["value"];
export const optimizationEffortSchema = z.enum(
  OPTIMIZATION_EFFORTS.map((preset) => preset.value) as [
    OptimizationEffort,
    ...OptimizationEffort[],
  ],
);

export function optimizationEffort(effort: OptimizationEffort) {
  const match = OPTIMIZATION_EFFORTS.find((preset) => preset.value === effort);
  if (!match) throw new Error(`Unknown optimization effort: ${effort}`);
  return match;
}

export const listOptimizationsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((part) => part.trim().toUpperCase())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(optimizationStatusSchema).optional()),
  subjectKind: climbSubjectKindSchema.optional(),
  subjectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  includeDrafts: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => value === true || value === "true" || value === "1"),
});
export type ListOptimizationsQuery = z.infer<
  typeof listOptimizationsQuerySchema
>;

export const optimizationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: optimizationStatusSchema,
  mode: z.enum(["MANUAL", "AUTO"]),
  autonomous: z.boolean(),
  stopReason: z.string().nullable(),
  subjectKind: climbSubjectKindSchema,
  subjectId: z.string(),
  subjectName: z.string(),
  lever: leverKindSchema.nullable(),
  round: z.number().int(),
  maxRounds: z.number().int(),
  before: z.number().nullable(),
  after: z.number().nullable(),
  delta: z.number().nullable(),
  path: z.array(z.number()),
  creditsSpent: z.number().int(),
  creditsReserved: z.number().int(),
  summary: z.string().nullable(),
  href: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OptimizationSummary = z.infer<typeof optimizationSummarySchema>;

export const listOptimizationsResponseSchema = z.object({
  items: z.array(optimizationSummarySchema),
});
export type ListOptimizationsResponse = z.infer<
  typeof listOptimizationsResponseSchema
>;

export const baselineDiscoveryQuerySchema = z
  .object({
    subjectKind: climbSubjectKindSchema,
    subjectId: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export const baselineRunSchema = z.object({
  resolvedModel: z.string().nullable(),
  runId: z.string(),
  agent: z.string(),
  model: z.string(),
  status: z.string(),
  createdAt: z.string(),
  outcome: z.object({
    passedCriteria: z.number(),
    totalCriteria: z.number(),
    judgingStatus: z.string().nullable(),
  }),
  surfaces: z.array(
    z.object({
      lever: z.string(),
      label: z.string(),
      targetRef: z.unknown(),
      evidence: z.unknown(),
      command: z.unknown().optional(),
    }),
  ),
  evidenceStatus: z.object({
    surfaces: z.string().nullable(),
    cli: z.string().nullable(),
  }),
  eligibility: z.object({
    eligible: z.boolean(),
    reason: z.string().nullable(),
    baselineRunIds: z.array(z.string()),
  }),
});
export const baselineDiscoveryResponseSchema = z.object({
  items: z.array(baselineRunSchema),
  nextCursor: z.string().nullable(),
  note: z.string(),
});
export type BaselineRun = z.infer<typeof baselineRunSchema>;
export type BaselineDiscoveryResponse = z.infer<
  typeof baselineDiscoveryResponseSchema
>;

const targetSchema = z.object({
  agent: schedulableAgentSchema.optional(),
  model: z.string().optional(),
});

const planShape = {
  effort: optimizationEffortSchema.optional(),
  sampleCount: z.number().int().min(1).max(100).optional(),
  maxRounds: z.number().int().min(1).max(100).optional(),
  maxTrialsPerRound: z.number().int().min(1).max(10).optional(),
};

function refinePlan(
  value: {
    effort?: OptimizationEffort;
    sampleCount?: number;
    maxRounds?: number;
    target?: { agent?: string; model?: string };
  },
  ctx: z.RefinementCtx,
) {
  if (value.effort && (value.sampleCount || value.maxRounds))
    ctx.addIssue({
      code: "custom",
      path: ["effort"],
      message: "Pass effort or sampleCount/maxRounds, not both",
    });
  if (value.target?.model && !value.target.agent)
    ctx.addIssue({
      code: "custom",
      path: ["target", "agent"],
      message: "Pin an agent with the model",
    });
}

export const startOptimizationBodySchema = z
  .object({
    subjectKind: climbSubjectKindSchema,
    subjectId: z.string().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    ...planShape,
    creditCap: z.number().int().nonnegative().optional(),
    targetScore: z.number().min(0).max(1).optional(),
    target: targetSchema.extend({ agent: schedulableAgentSchema }).optional(),
    fromRun: z.string().min(1).optional(),
  })
  .strict()
  .superRefine(refinePlan)
  .superRefine((value, ctx) => {
    if (!!value.target === !!value.fromRun)
      ctx.addIssue({
        code: "custom",
        message: "Pass target or fromRun, not both",
        path: ["target"],
      });
  });
export type StartOptimizationBody = z.infer<typeof startOptimizationBodySchema>;
export type StartOptimizationBodyInput = z.input<
  typeof startOptimizationBodySchema
>;

export function optimizationPlan(body: {
  effort?: OptimizationEffort;
  sampleCount?: number;
  maxRounds?: number;
}) {
  const preset = optimizationEffort(body.effort ?? "MEDIUM");
  return {
    sampleCount: body.sampleCount ?? preset.sampleCount,
    maxRounds: body.maxRounds ?? preset.maxRounds,
  };
}

export const estimateOptimizationBodySchema = z
  .object({
    subjectKind: climbSubjectKindSchema,
    subjectId: z.string().min(1),
    ...planShape,
    target: targetSchema.optional(),
  })
  .strict()
  .superRefine(refinePlan);
export type EstimateOptimizationBody = z.infer<
  typeof estimateOptimizationBodySchema
>;

export const RUN_CREDIT_BASES = [
  "subject-history",
  "model-history",
  "catalog-rates",
  "platform-history",
  "byok",
  "reserve",
] as const;
export const runCreditBasisSchema = z.enum(RUN_CREDIT_BASES);
export type RunCreditBasis = z.infer<typeof runCreditBasisSchema>;

export const optimizationEstimateSchema = z.object({
  sampleCount: z.number().int(),
  maxRounds: z.number().int(),
  runsPerTrial: z.number(),
  executionCredits: z.number(),
  judgeCredits: z.number(),
  leverPassCredits: z.number(),
  trialCredits: z.number(),
  estimate: z.number().int(),
  approximate: z.boolean().default(false),
  basis: runCreditBasisSchema.optional(),
});
export type OptimizationEstimate = z.infer<typeof optimizationEstimateSchema>;

export const diagnoseBodySchema = z
  .object({
    subjectKind: climbSubjectKindSchema,
    subjectId: z.string().min(1),
  })
  .strict();
export type DiagnoseBody = z.infer<typeof diagnoseBodySchema>;

export const diagnosisSchema = z.object({
  id: z.string(),
  status: z.enum(["GENERATING", "READY", "FAILED"]),
  subjectKind: climbSubjectKindSchema,
  subjectId: z.string(),
  runCount: z.number().int(),
  summary: z.string().nullable(),
  recommendedLever: leverKindSchema.nullable(),
  recommendedTarget: z.unknown().nullable(),
  clusters: z.array(
    z.object({
      title: z.string(),
      failureMode: z.string(),
      criterionIds: z.array(z.string()),
      runIds: z.array(z.string()),
      lever: leverKindSchema.nullable(),
      targetRef: z.unknown().nullable(),
      confidence: z.number(),
    }),
  ),
  unsupportedLevers: z.array(leverKindSchema).default([]),
  createdAt: z.string(),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

export const candidateExecutionSchema = z.object({
  runId: z.string(),
  startMode: z.enum(["checkpoint", "fresh"]),
  checkpointId: z.string().nullable(),
  sourceRunId: z.string().nullable(),
  status: z.string(),
  continuation: z.literal("running-process").optional(),
  sourceAttempt: z.number().int().positive().optional(),
  estimatedSavedWork: z
    .object({
      elapsedMs: z.number().nonnegative(),
      usage: z.object({
        input_tokens: z.number().nonnegative(),
        output_tokens: z.number().nonnegative(),
        cache_read_input_tokens: z.number().nonnegative(),
        cache_creation_input_tokens: z.number().nonnegative(),
      }),
      attribution: z.literal("approximate"),
    })
    .optional(),
});
export type CandidateExecution = z.infer<typeof candidateExecutionSchema>;

export const trialRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  failureReason: z.string().nullable(),
  exitReason: z.string().nullable(),
  candidateDelivery: candidateDeliverySchema.nullable().optional(),
  candidateExecution: candidateExecutionSchema.nullable().optional(),
  cliCoverage: cliRuleCoverageSchema.nullable().optional(),
  passed: z.boolean().nullable(),
  criteria: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean().nullable(),
      reasoning: z.string(),
    }),
  ),
  levers: z.array(
    z.object({
      lever: z.string(),
      attributed: z.boolean(),
      note: z.string().nullable(),
    }),
  ),
});
export type TrialRun = z.infer<typeof trialRunSchema>;

export const trialSchema = z.object({
  id: z.string(),
  climbId: z.string(),
  roundNumber: z.number().int(),
  key: z.string(),
  parentTrialId: z.string().nullable(),
  parentKey: z.string().nullable(),
  title: z.string(),
  hypothesis: z.string().nullable(),
  lever: leverKindSchema.nullable(),
  kind: interventionKindSchema,
  status: z.enum(TRIAL_STATUSES),
  verdict: z.enum(TRIAL_VERDICTS).nullable(),
  score: z.number().nullable(),
  baselineScore: z.number().nullable(),
  sessions: z.number().int(),
  failedSessions: z.number().int(),
  isBaseline: z.boolean(),
  adopted: z.boolean(),
  adoptedAt: z.string().nullable(),
  outcome: z.string().nullable(),
  after: z.unknown(),
  before: z.unknown(),
  startingPoints: candidateStartsSchema.optional(),
  runs: z.array(trialRunSchema),
  createdAt: z.string(),
});
export type Trial = z.infer<typeof trialSchema>;

export const roundSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  status: z.enum(ROUND_STATUSES),
  narrative: z.string().nullable(),
  trials: z.array(trialSchema),
});
export type Round = z.infer<typeof roundSchema>;

export const OPTIMIZATION_NEXT_ACTIONS = [
  "START",
  "WAIT",
  "AUTHOR_TRIAL",
  "LAUNCH_ROUND",
  "ADOPT",
  "RESUME",
  "NONE",
] as const;
export const optimizationNextActionSchema = z.enum(OPTIMIZATION_NEXT_ACTIONS);
export type OptimizationNextAction = z.infer<
  typeof optimizationNextActionSchema
>;

export const optimizationDetailSchema = optimizationSummarySchema.extend({
  baselineTrialId: z.string().nullable(),
  nextAction: optimizationNextActionSchema,
  settings: z.object({
    sampleCount: z.number().int(),
    maxRounds: z.number().int(),
    maxTrialsPerRound: z.number().int(),
    creditCap: z.number().int(),
    targetScore: z.number(),
    pinnedAgent: z.string().nullable(),
    pinnedModel: z.string().nullable(),
    continuedAtRound: z.number().int().nullable(),
  }),
  direction: climbDirectionSchema,
  rounds: z.array(roundSchema),
});
export type OptimizationDetail = z.infer<typeof optimizationDetailSchema>;

export const NOTHING_TO_CHANGE = "nothing to change";

export function nextOptimizationAction(detail: {
  status: OptimizationStatus;
  stopReason?: string | null;
  baselineTrialId: string | null;
  rounds: readonly {
    number: number;
    status: (typeof ROUND_STATUSES)[number];
    trials: readonly Pick<
      Trial,
      "id" | "kind" | "status" | "score" | "adopted"
    >[];
  }[];
}): OptimizationNextAction {
  if (detail.status === "DRAFT") return "START";
  if (detail.status === "PAUSED") return "RESUME";
  if (detail.status === "DONE" || detail.status === "ARCHIVED") return "NONE";
  if (detail.stopReason === NOTHING_TO_CHANGE) return "NONE";
  const trials = detail.rounds.flatMap((round) => round.trials);
  if (trials.some((trial) => trial.status === "RUNNING")) return "WAIT";
  if (trials.some((trial) => trial.status === "DRAFT")) return "LAUNCH_ROUND";
  const baseline = trials.find((trial) => trial.kind === "BASELINE");
  const last = detail.rounds.at(-1);
  if (
    !last ||
    last.number === 0 ||
    ["PROPOSING", "PROPOSED", "SETTLED"].includes(last.status)
  )
    return baseline?.status === "SETTLED" ? "AUTHOR_TRIAL" : "WAIT";
  return "WAIT";
}

export const optimizationHandoffSchema = z.object({
  trialId: z.string(),
  trialKey: z.string(),
  prompt: z.string(),
});
export type OptimizationHandoff = z.infer<typeof optimizationHandoffSchema>;

export const listTrialsResponseSchema = z.object({
  items: z.array(trialSchema),
});
export type ListTrialsResponse = z.infer<typeof listTrialsResponseSchema>;

export const trialDocumentSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
});
export const trialContentSchema = z.object({
  trialId: z.string(),
  kind: interventionKindSchema,
  documents: z.array(trialDocumentSchema),
  copyableBody: z.string().nullable(),
  configSnapshot: z.unknown(),
});
export type TrialContent = z.infer<typeof trialContentSchema>;

export const createTrialBodySchema = z
  .object({
    trial: trialInputSchema,
    files: overrideFilesSchema.optional(),
    fork: z
      .object({ runId: z.string().min(1), boundarySeq: z.string().min(1) })
      .strict()
      .optional(),
    launch: z.boolean().default(false),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CreateTrialBody = z.infer<typeof createTrialBodySchema>;
export type CreateTrialBodyInput = z.input<typeof createTrialBodySchema>;

export const skillFilesResponseSchema = z.object({
  versionId: z.string(),
  files: overrideFilesSchema,
});
export type SkillFilesResponse = z.infer<typeof skillFilesResponseSchema>;

export const pageBodyResponseSchema = z.object({
  source: z.string().optional(),
  url: z.string(),
  body: z.string(),
  contentType: z.string().optional(),
});
export type PageBodyResponse = z.infer<typeof pageBodyResponseSchema>;

export const launchTrialResponseSchema = z.object({
  trialId: z.string(),
  batchIds: z.array(z.string()),
  runIds: z.array(z.string()),
});
export type LaunchTrialResponse = z.infer<typeof launchTrialResponseSchema>;

export const createDraftOptimizationBodySchema = z
  .object({
    subjectKind: climbSubjectKindSchema,
    subjectId: z.string().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    ...planShape,
    target: targetSchema.optional(),
    autonomous: z.boolean().optional(),
  })
  .strict()
  .superRefine(refinePlan);
export type CreateDraftOptimizationBody = z.infer<
  typeof createDraftOptimizationBodySchema
>;

const planPatchShape = {
  name: z.string().trim().min(1).max(200).optional(),
  ...planShape,
  target: targetSchema.optional(),
};
export const optimizationPlanPatchSchema = z
  .object(planPatchShape)
  .strict()
  .superRefine(refinePlan);
export type OptimizationPlanPatch = z.infer<typeof optimizationPlanPatchSchema>;

export const startDraftOptimizationBodySchema = z
  .object({
    ...planPatchShape,
    creditCap: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine(refinePlan);
export type StartDraftOptimizationBody = z.infer<
  typeof startDraftOptimizationBodySchema
>;

export const setDirectionBodySchema = climbDirectionPatchSchema;
export const setModeBodySchema = z.object({ autonomous: z.boolean() }).strict();

export const launchRoundResponseSchema = z.object({
  roundNumber: z.number().int().nullable(),
  launched: z.array(z.string()),
  alreadyLaunched: z.boolean(),
});
export type LaunchRoundResponse = z.infer<typeof launchRoundResponseSchema>;

export const resolveChatResponseSchema = z.object({
  chatId: z.string(),
  href: z.string(),
});
export type ResolveChatResponse = z.infer<typeof resolveChatResponseSchema>;

export const continueOptimizationBodySchema = z
  .object({
    rounds: z.number().int().min(1).max(20).default(1),
    maxTrialsPerRound: z.number().int().min(1).max(10).optional(),
  })
  .strict();
export type ContinueOptimizationBody = z.infer<
  typeof continueOptimizationBodySchema
>;

export const patchOptimizationBodySchema = z
  .object({
    ...planPatchShape,
    direction: climbDirectionPatchSchema.optional(),
    autonomous: z.boolean().optional(),
  })
  .strict()
  .superRefine(refinePlan);
export type PatchOptimizationBody = z.infer<typeof patchOptimizationBodySchema>;
