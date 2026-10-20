import { z } from "zod";
import { visibilityVerdictSchema } from "./preference";
import { agentSchema } from "./runs";

export const runRequestStatusSchema = z.enum([
  "PENDING",
  "PREPARING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
]);

export const runRequestResultSchema = z.enum([
  "PENDING",
  "PASSED",
  "MEASURED",
  "QUALITY_FAILED",
  "EXECUTION_FAILED",
  "INPUT_FAILED",
  "JUDGE_FAILED",
  "INCOMPLETE",
  "CANCELED",
]);
export type RunRequestResult = z.infer<typeof runRequestResultSchema>;

export const runRequestCriterionResultSchema = z.object({
  criterionId: z.string().nullable(),
  name: z.string(),
  passed: z.boolean().nullable(),
  reasoning: z.string().nullable(),
});

export const runRequestRunSchema = z.object({
  id: z.string(),
  url: z.string().url().optional(),
  batchId: z.string(),
  status: z.string(),
  agent: agentSchema,
  model: z.string(),
  result: runRequestResultSchema,
  judge: z.object({ status: z.string() }).nullable(),
  criterionResults: z.array(runRequestCriterionResultSchema),
  preference: visibilityVerdictSchema.nullable().optional(),
  measurement: z.enum(["experience", "preference"]).optional(),
});

export const runRequestResponseSchema = z.object({
  id: z.string(),
  status: runRequestStatusSchema,
  result: runRequestResultSchema,
  error: z.string().nullable().optional(),
  inputs: z.unknown().optional(),
  settled: z.boolean(),
  counts: z.object({
    requestedRuns: z.number().int().nonnegative(),
    createdRuns: z.number().int().nonnegative(),
    terminalRuns: z.number().int().nonnegative(),
    judgedRuns: z.number().int().nonnegative(),
    passedRuns: z.number().int().nonnegative(),
    measuredRuns: z.number().int().nonnegative().optional(),
    qualityFailedRuns: z.number().int().nonnegative(),
    executionFailedRuns: z.number().int().nonnegative(),
    judgeFailedRuns: z.number().int().nonnegative(),
    pendingRuns: z.number().int().nonnegative(),
  }),
  batches: z.array(
    z.object({ id: z.string(), runs: z.array(runRequestRunSchema) }),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RunRequestResponse = z.infer<typeof runRequestResponseSchema>;
