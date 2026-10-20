import { z } from "zod";
import { INTERVENTION_KINDS } from "./climb-kinds";
import { listQuerySchema, listResponseSchema } from "./common";
import { sessionAnalysisSchema } from "./sessionAnalysis";

export const RUN_STATUSES = [
  "QUEUED",
  "CLAIMED",
  "PROVISIONING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELED",
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const AGENTS = [
  "CLAUDE_CODE",
  "CODEX_CLI",
  "CURSOR",
  "PI",
  "OPENCODE",
] as const;
export const agentSchema = z.enum(AGENTS);
export type Agent = z.infer<typeof agentSchema>;

export const OBSERVED_PROVIDER_SOURCES = [
  "AGENT_STREAM",
  "GATEWAY_RESPONSE",
  "GATEWAY_AUDIT",
  "CANARY",
] as const;
export const observedProviderSourceSchema = z.enum(OBSERVED_PROVIDER_SOURCES);

export const selectedProviderSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
});
export type SelectedProvider = z.infer<typeof selectedProviderSchema>;

export const observedProviderSchema = z.object({
  slug: z.string(),
  source: observedProviderSourceSchema,
});
export type ObservedProvider = z.infer<typeof observedProviderSchema>;

export const RUN_TRIGGER_SOURCES = [
  "UNKNOWN",
  "UI",
  "API",
  "CADENCE",
  "STAFF",
  "OPERATOR",
  "GITHUB",
] as const;
export const runTriggerSourceSchema = z.enum(RUN_TRIGGER_SOURCES);
export type RunTriggerSource = z.infer<typeof runTriggerSourceSchema>;

export const runTriggeredBySchema = z.object({
  source: runTriggerSourceSchema,
  userId: z.string().nullable(),
  email: z.string().nullable(),
});
export type RunTriggeredBy = z.infer<typeof runTriggeredBySchema>;

export const runOptimizationTrialSchema = z.object({
  optimizationId: z.string(),
  trialId: z.string(),
  key: z.string(),
  title: z.string(),
  kind: z.enum(INTERVENTION_KINDS),
});
export type RunOptimizationTrial = z.infer<typeof runOptimizationTrialSchema>;

export const runCreditsChargedSchema = z.number().int().nullable();

export const runStatusFilterSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  )
  .pipe(z.array(runStatusSchema).min(1));

export const runListQuerySchema = listQuerySchema.extend({
  status: runStatusFilterSchema.optional(),
  batch: z.string().optional(),
  prompt: z.string().optional(),
  experiment: z.string().optional(),
  evalSet: z.string().optional(),
  since: z.string().optional(),
});
export type RunListQuery = z.infer<typeof runListQuerySchema>;

export const runListItemSchema = z.object({
  id: z.string(),
  status: runStatusSchema,
  agent: agentSchema,
  model: z.string(),
  resolvedModel: z.string().nullable().optional(),
  modelDisplayName: z.string().nullable().optional(),
  selectedProvider: selectedProviderSchema.nullable().optional(),
  observedProvider: observedProviderSchema.nullable().optional(),
  promptId: z.string(),
  promptSnippet: z.string(),
  batchId: z.string(),
  experiment: z.string().nullable(),
  evalSetId: z.string().nullable(),
  evalRevision: z.string().optional(),
  optimizationTrial: runOptimizationTrialSchema.nullable().optional(),
  turns: z.number().int().nullable(),
  usdCost: z.number().nullable(),
  creditsCharged: runCreditsChargedSchema.optional(),
  triggeredBy: runTriggeredBySchema.optional(),
  durationMs: z.number().int().nullable(),
  exitReason: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  parentRunId: z.string().nullable(),
  fetchForkPlanId: z.string().nullable(),
});
export type RunListItem = z.infer<typeof runListItemSchema>;

export const runListResponseSchema = listResponseSchema(runListItemSchema);
export type RunListResponse = z.infer<typeof runListResponseSchema>;

export const runSkillSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("saved"),
    skillId: z.string(),
    name: z.string(),
    label: z.string(),
  }),
  z.object({
    source: z.literal("input"),
    name: z.string(),
    commit: z.string().nullable(),
    pullNumber: z.number().int().nullable(),
  }),
]);
export type RunSkill = z.infer<typeof runSkillSchema>;

export const runDetailSchema = runListItemSchema
  .omit({ promptSnippet: true })
  .extend({
    promptText: z.string(),
    attempt: z.number().int(),
    cancelRequested: z.boolean(),
    failureReason: z.string().nullable(),
    repoUrl: z.string().nullable(),
    repoRef: z.string().nullable(),
    scenario: z.string(),
    funding: z.string(),
    usage: z.unknown().nullable(),
    hasDiff: z.boolean(),
    claimedAt: z.string().nullable(),
    criterionResults: z.array(
      z.object({
        criterionId: z.string().nullable(),
        name: z.string(),
        passed: z.boolean().nullable(),
        reasoning: z.string().nullable(),
      }),
    ),
    skills: z.array(runSkillSchema).optional(),
  });
export type RunDetail = z.infer<typeof runDetailSchema>;

export const cancelRunResponseSchema = z.object({
  id: z.string(),
  status: runStatusSchema,
  cancelRequested: z.boolean(),
  note: z.string().optional(),
});
export type CancelRunResponse = z.infer<typeof cancelRunResponseSchema>;

export const regradeRunResponseSchema = z.object({
  runId: z.string(),
  evalSetId: z.string().nullable(),
  criteria: z.number().int(),
});
export type RegradeRunResponse = z.infer<typeof regradeRunResponseSchema>;

export const RUN_INSIGHT_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETE",
  "FAILED",
  "SKIPPED",
] as const;
export const runInsightStatusSchema = z.enum(RUN_INSIGHT_STATUSES);
export type RunInsightStatus = z.infer<typeof runInsightStatusSchema>;

export const insightPassSchema = z.object({
  status: runInsightStatusSchema,
  model: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  usdCost: z.number().nullable(),
  error: z.string().nullable(),
});
export type InsightPass = z.infer<typeof insightPassSchema>;

export const runDecisionSchema = z.object({
  index: z.number().int(),
  category: z.string(),
  categoryRaw: z.string().nullable(),
  chosenName: z.string(),
  chosenEcosystem: z.string().nullable(),
  chosenPackage: z.string().nullable(),
  reversed: z.boolean(),
  detail: z.unknown(),
});
export type RunDecision = z.infer<typeof runDecisionSchema>;

export const RUN_INSIGHT_PASS_KINDS = [
  "ANALYSIS",
  "CLI_DISCOVERY",
  "LEVER",
  "EXPERIMENT_DELTA",
] as const;
export const runInsightPassKindSchema = z.enum(RUN_INSIGHT_PASS_KINDS);
export type RunInsightPassKind = z.infer<typeof runInsightPassKindSchema>;

export const insightPipelinePassSchema = insightPassSchema.extend({
  kind: runInsightPassKindSchema,
});
export type InsightPipelinePass = z.infer<typeof insightPipelinePassSchema>;

export const runInsightResponseSchema = z.object({
  runId: z.string(),
  decision: insightPassSchema,
  passes: z.array(insightPipelinePassSchema),
  decisions: z.array(runDecisionSchema),
  experimentDelta: z.unknown().nullable(),
  visibilityVerdict: z.unknown().nullable(),
  analysis: sessionAnalysisSchema.nullable(),
});
export type RunInsightResponse = z.infer<typeof runInsightResponseSchema>;

export const runEventSchema = z.looseObject({
  run_id: z.string(),
  seq: z.number(),
  turn: z.number(),
  ts: z.string(),
  type: z.string(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const runCompareSideSchema = z
  .object({
    runRequest: z.string().min(1).optional(),
    batch: z.array(z.string().min(1)).min(1).max(100).optional(),
    evalSet: z.string().min(1).optional(),
    evalRevision: z.string().min(1).optional(),
    trial: z.string().min(1).optional(),
    experiment: z.string().min(1).optional(),
    agent: z.array(agentSchema).min(1).optional(),
    model: z.array(z.string()).min(1).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
  })
  .strict()
  .refine(
    (side) =>
      side.runRequest !== undefined ||
      side.batch !== undefined ||
      side.evalSet !== undefined ||
      side.experiment !== undefined ||
      side.trial !== undefined,
    "Select runs with runRequest, batch, evalSet, experiment, or trial",
  );
export type RunCompareSide = z.infer<typeof runCompareSideSchema>;

export const runCompareBodySchema = z
  .object({
    baseline: runCompareSideSchema,
    candidate: runCompareSideSchema,
  })
  .strict();
export type RunCompareBody = z.infer<typeof runCompareBodySchema>;

export const runCompareStatsSchema = z.object({
  runs: z.number().int(),
  finished: z.number().int(),
  succeeded: z.number().int(),
  judged: z.number().int(),
  passed: z.number().int(),
  passRate: z.number().nullable(),
  medianTurns: z.number().nullable(),
  medianUsdCost: z.number().nullable(),
  medianDurationMs: z.number().nullable(),
  criteria: z.array(
    z.object({
      name: z.string(),
      judged: z.number().int(),
      passed: z.number().int(),
      passRate: z.number().nullable(),
    }),
  ),
});
export type RunCompareStats = z.infer<typeof runCompareStatsSchema>;

export const runCompareDeltaSchema = z.object({
  passRate: z.number().nullable(),
  medianTurns: z.number().nullable(),
  medianUsdCost: z.number().nullable(),
  medianDurationMs: z.number().nullable(),
  criteria: z.array(
    z.object({ name: z.string(), passRate: z.number().nullable() }),
  ),
});
export type RunCompareDelta = z.infer<typeof runCompareDeltaSchema>;

export const runCompareRowSchema = z.object({
  baseline: runCompareStatsSchema,
  candidate: runCompareStatsSchema,
  delta: runCompareDeltaSchema,
});

export const runCompareMixedRevisionSchema = z.object({
  evalSetId: z.string().nullable(),
  promptId: z.string().nullable(),
  revisions: z.array(z.string()),
});
export type RunCompareMixedRevision = z.infer<
  typeof runCompareMixedRevisionSchema
>;

export const runCompareTrialSchema = runOptimizationTrialSchema.extend({
  runs: z.number().int(),
});
export type RunCompareTrial = z.infer<typeof runCompareTrialSchema>;

export const runCompareResponseSchema = z.object({
  overall: runCompareRowSchema,
  targets: z.array(
    runCompareRowSchema.extend({ agent: agentSchema, model: z.string() }),
  ),
  sides: z.object({
    baseline: z.object({
      evalRevisions: z.array(z.string()),
      mixedRevisions: z.array(runCompareMixedRevisionSchema).optional(),
      truncated: z.boolean(),
      trials: z.array(runCompareTrialSchema).optional(),
    }),
    candidate: z.object({
      evalRevisions: z.array(z.string()),
      mixedRevisions: z.array(runCompareMixedRevisionSchema).optional(),
      truncated: z.boolean(),
      trials: z.array(runCompareTrialSchema).optional(),
    }),
  }),
});
export type RunCompareResponse = z.infer<typeof runCompareResponseSchema>;
