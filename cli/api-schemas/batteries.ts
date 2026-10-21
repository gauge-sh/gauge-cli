import { z } from "zod";
import { listQuerySchema, listResponseSchema } from "./common";

export const BATTERY_AGENTS = [
  "CLAUDE_CODE",
  "CODEX_CLI",
  "CURSOR",
  "PI",
  "OPENCODE",
  "ANTIGRAVITY",
] as const;
export const BATTERY_CADENCES = ["NONE"] as const;

export const batteryAgentSchema = z.enum(BATTERY_AGENTS);
export type BatteryAgent = z.infer<typeof batteryAgentSchema>;

export const BATTERY_MAX_LIMITS = {
  maxTurns: 30,
  wallClockS: 5400,
  maxUsd: 10,
} as const;

export const MAX_SAMPLES_PER_CYCLE = 50;

export const batteryLimitsSchema = z.object({
  maxTurns: z.number().positive().max(BATTERY_MAX_LIMITS.maxTurns).optional(),
  wallClockS: z
    .number()
    .positive()
    .max(BATTERY_MAX_LIMITS.wallClockS)
    .optional(),
  maxUsd: z.number().positive().max(BATTERY_MAX_LIMITS.maxUsd).optional(),
});

export const batterySkillRefSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*@\S+$/,
    'skills entries must be "name@label" (a bare name is a search, not a reference)',
  );

export const batterySkillsSchema = z.array(batterySkillRefSchema);

export const batteryScheduleSpecSchema = z.object({
  repoUrl: z.string().nullish(),
  repoRef: z.string().nullish(),
  model: z.string().nullable().optional(),
  agents: z.array(batteryAgentSchema).optional(),
  samplesPerCycle: z
    .number()
    .int()
    .min(1)
    .max(MAX_SAMPLES_PER_CYCLE)
    .optional(),
  cadence: z.enum(BATTERY_CADENCES).optional(),
  experiment: z.string().optional(),
  limits: batteryLimitsSchema.optional(),
  skills: batterySkillsSchema.optional(),
});

export const batteryDefaultsSchema = z.object({
  isBranded: z.boolean().optional(),
  topic: z.string().optional(),
  tags: z.array(z.string()).optional(),
  model: z.string().nullable().optional(),
  agents: z.array(batteryAgentSchema).optional(),
  samplesPerCycle: z
    .number()
    .int()
    .min(1)
    .max(MAX_SAMPLES_PER_CYCLE)
    .optional(),
  cadence: z.enum(BATTERY_CADENCES).optional(),
  limits: batteryLimitsSchema.optional(),
  skills: batterySkillsSchema.optional(),
});

export const batteryPromptSpecSchema = z.object({
  key: z.string().min(1),
  text: z.string().min(1),
  isBranded: z.boolean().optional(),
  topic: z.string().optional(),
  tags: z.array(z.string()).optional(),
  experiment: z.string().optional(),
  schedules: z.array(batteryScheduleSpecSchema).optional(),
});

export const batterySpecSchema = z.object({
  version: z.literal(1),
  org: z.string().optional(),
  experiment: z.string().optional(),
  expand: z.boolean().optional(),
  defaults: batteryDefaultsSchema.optional(),
  prompts: z.array(batteryPromptSpecSchema).min(1),
});
export type BatterySpec = z.infer<typeof batterySpecSchema>;

export const batteryPlanScheduleSchema = z.object({
  action: z.enum(["create", "update", "none"]),
  repoUrl: z.string().nullable(),
  repoRef: z.string().nullable(),
  runs: z.number().int(),
});
export type BatteryPlanSchedule = z.infer<typeof batteryPlanScheduleSchema>;

export const batteryPlanPromptSchema = z.object({
  key: z.string(),
  action: z.enum(["create", "update"]),
  schedules: z.array(batteryPlanScheduleSchema),
});
export type BatteryPlanPrompt = z.infer<typeof batteryPlanPromptSchema>;

export const batteryPlanSchema = z.object({
  dryRun: z.literal(true),
  org: z.string(),
  experiment: z.string().nullable(),
  expand: z.boolean(),
  prompts: z.array(batteryPlanPromptSchema),
  summary: z.object({
    promptsToCreate: z.number().int(),
    promptsToUpdate: z.number().int(),
    schedulesToCreate: z.number().int(),
    schedulesToUpdate: z.number().int(),
    runsToEnqueue: z.number().int(),
    runsByAgent: z.record(z.string(), z.number().int()),
    estimatedCredits: z.number().int(),
  }),
});
export type BatteryPlan = z.infer<typeof batteryPlanSchema>;

export const batteryApplyResponseSchema = z.object({
  batchIds: z.array(z.string()),
  runIds: z.array(z.string()),
  experiment: z.string().nullable(),
  blocked: z.enum(["insufficient_credits", "needs_provider_key"]).optional(),
});
export type BatteryApplyResponse = z.infer<typeof batteryApplyResponseSchema>;

export const batchRunStatusSchema = z.enum([
  "QUEUED",
  "CLAIMED",
  "PROVISIONING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELED",
]);
export type BatchRunStatus = z.infer<typeof batchRunStatusSchema>;

export const batchListQuerySchema = listQuerySchema.extend({
  promptId: z.string().optional(),
  experiment: z.string().optional(),
});
export type BatchListQuery = z.infer<typeof batchListQuerySchema>;

export const batchSummarySchema = z.object({
  id: z.string(),
  promptId: z.string(),
  promptText: z.string(),
  experiment: z.string().nullable(),
  createdAt: z.string(),
  runCounts: z.record(z.string(), z.number().int()),
});
export type BatchSummary = z.infer<typeof batchSummarySchema>;

export const batchListResponseSchema = listResponseSchema(batchSummarySchema);
export type BatchListResponse = z.infer<typeof batchListResponseSchema>;

export const batchRunSummarySchema = z.object({
  id: z.string(),
  agent: z.string(),
  model: z.string(),
  status: batchRunStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type BatchRunSummary = z.infer<typeof batchRunSummarySchema>;

export const batchDetailSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  promptText: z.string(),
  scenario: z.string(),
  repoUrl: z.string().nullable(),
  repoRef: z.string().nullable(),
  experiment: z.string().nullable(),
  funding: z.string(),
  createdAt: z.string(),
  runCounts: z.record(z.string(), z.number().int()),
  runs: z.array(batchRunSummarySchema),
});
export type BatchDetail = z.infer<typeof batchDetailSchema>;
