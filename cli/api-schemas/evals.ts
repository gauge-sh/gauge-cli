import { z } from "zod";
import { listResponseSchema } from "./common";
import {
  ownedConfigurationInputSchema,
  ownedConfigurationPatchShape,
  ownedConfigurationSchema,
  runEvalBodySchema,
} from "./ownedConfigurations";
import {
  agentSchema,
  runCreditsChargedSchema,
  runTriggeredBySchema,
} from "./runs";

export const criterionSchema = z.object({
  id: z.string(),
  name: z.string(),
  rubric: z.string(),
  position: z.number().int(),
});
export type Criterion = z.infer<typeof criterionSchema>;

export const criterionInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).optional(),
  rubric: z.string().min(1),
});
export type CriterionInput = z.infer<typeof criterionInputSchema>;

export const evalSetSchema = z
  .object({
    id: z.string(),
    suiteId: z.string().nullable(),
    name: z.string(),
    promptText: z.string(),
    createdAt: z.string(),
    criteria: z.array(criterionSchema),
    tags: z.array(z.string()),
  })
  .extend(ownedConfigurationSchema.shape);
export type EvalSet = z.infer<typeof evalSetSchema>;

export const agentPassRateSchema = z.object({
  agent: agentSchema,
  model: z.string(),
  runId: z.string(),
  finishedAt: z.string().nullable(),
  passed: z.number().int(),
  total: z.number().int(),
});
export type AgentPassRate = z.infer<typeof agentPassRateSchema>;

export const evalSetStatSchema = z.object({
  passRates: z.array(agentPassRateSchema),
  runCount: z.number().int(),
  judgedRuns: z.number().int(),
  passedRuns: z.number().int(),
});
export type EvalSetStat = z.infer<typeof evalSetStatSchema>;

const csv = z.string().transform((s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);

export const listEvalSetsQuerySchema = z.object({
  agents: csv.pipe(z.array(agentSchema)).optional(),
  models: csv.optional(),
  since: z.coerce.date().optional(),
});
export type ListEvalSetsQuery = z.infer<typeof listEvalSetsQuerySchema>;

export const evalSetListItemSchema = evalSetSchema.extend({
  stats: evalSetStatSchema,
});
export type EvalSetListItem = z.infer<typeof evalSetListItemSchema>;

export const listEvalSetsResponseSchema = z.object({
  items: z.array(evalSetListItemSchema),
});
export type ListEvalSetsResponse = z.infer<typeof listEvalSetsResponseSchema>;

export const createEvalSetBodySchema = z
  .object({
    name: z.string().min(1),
    promptText: z.string().min(1),
    criteria: z.array(criterionInputSchema).min(1),
    tags: z.array(z.string()).optional(),
  })
  .extend(ownedConfigurationInputSchema.shape)
  .strict();
export type CreateEvalSetBody = z.infer<typeof createEvalSetBodySchema>;
export type CreateEvalSetBodyInput = z.input<typeof createEvalSetBodySchema>;

export const updateEvalSetBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    promptText: z.string().min(1).optional(),
    criteria: z.array(criterionInputSchema).min(1).optional(),
    tags: z.array(z.string()).optional(),
  })
  .extend(ownedConfigurationPatchShape)
  .strict();
export type UpdateEvalSetBody = z.infer<typeof updateEvalSetBodySchema>;

export { runEvalBodySchema };

export const runEvalSetResponseSchema = z.object({
  batchIds: z.array(z.string()),
  runIds: z.array(z.string()),
  runRequestId: z.string().optional(),
});
export type RunEvalSetResponse = z.infer<typeof runEvalSetResponseSchema>;

export const evalSetRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  agent: agentSchema,
  model: z.string().nullable(),
  resolvedModel: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  creditsCharged: runCreditsChargedSchema.optional(),
  triggeredBy: runTriggeredBySchema.optional(),
  evalRevision: z.string().optional(),
  judge: z
    .object({ status: z.string(), error: z.string().nullable() })
    .nullable(),
  criterionResults: z.array(
    z.object({
      criterionId: z.string().nullable(),
      name: z.string(),
      passed: z.boolean().nullable(),
      reasoning: z.string().nullable(),
    }),
  ),
});
export type EvalSetRun = z.infer<typeof evalSetRunSchema>;

export const listEvalSetRunsResponseSchema =
  listResponseSchema(evalSetRunSchema);
export type ListEvalSetRunsResponse = z.infer<
  typeof listEvalSetRunsResponseSchema
>;
