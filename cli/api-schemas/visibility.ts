import { z } from "zod";
import {
  runVisibilityBodySchema,
  visibilityPromptSettingsInputShape,
  visibilityPromptSettingsPatchShape,
  visibilityPromptSettingsSchema,
  visibilityScenarioInputSchema,
  visibilityScenarioSchema,
} from "./ownedConfigurations";

export type {
  VisibilityPromptSettings,
  VisibilityScenario,
  VisibilityScenarioInput,
} from "./ownedConfigurations";

import { listResponseSchema } from "./common";
import {
  agentSchema,
  runCreditsChargedSchema,
  runTriggeredBySchema,
} from "./runs";

export const VISIBILITY_PROMPT_KINDS = ["HEAD_TO_HEAD", "RECOMMEND"] as const;
export const visibilityPromptKindSchema = z.enum(VISIBILITY_PROMPT_KINDS);
export type VisibilityPromptKind = z.infer<typeof visibilityPromptKindSchema>;

export const visibilityPromptSchema = visibilityPromptSettingsSchema.extend({
  id: z.string(),
  name: z.string(),
  kind: visibilityPromptKindSchema,
  promptText: z.string(),
  branded: z.boolean(),
  brandA: z.string().nullable(),
  brandB: z.string().nullable(),
  market: z
    .object({ id: z.string(), slug: z.string(), name: z.string() })
    .nullable(),
  position: z.number().int(),
  createdAt: z.string(),
  tags: z.array(z.string()),
  runCount: z.number().int(),
  lastRunAt: z.string().nullable(),
  scenarios: z.array(visibilityScenarioSchema),
});
export type VisibilityPrompt = z.infer<typeof visibilityPromptSchema>;

export const listVisibilityPromptsResponseSchema = z.object({
  items: z.array(visibilityPromptSchema),
});
export type ListVisibilityPromptsResponse = z.infer<
  typeof listVisibilityPromptsResponseSchema
>;

export const createVisibilityPromptBodySchema = z
  .object({
    name: z.string().min(1),
    promptText: z.string().min(1),
    kind: visibilityPromptKindSchema,
    branded: z.boolean().optional(),
    brandA: z.string().nullish(),
    brandB: z.string().nullish(),
    marketId: z.string().nullish(),
    tags: z.array(z.string()).optional(),
    agents: visibilityPromptSettingsInputShape.agents.optional(),
    skillRefs: visibilityPromptSettingsInputShape.skillRefs,
    mcpRefs: visibilityPromptSettingsInputShape.mcpRefs,
    connectionIds: visibilityPromptSettingsInputShape.connectionIds,
    cadence: visibilityPromptSettingsInputShape.cadence,
    sampleCount: visibilityPromptSettingsInputShape.sampleCount,
    scenarios: z.array(visibilityScenarioInputSchema).optional().default([]),
  })
  .strict();
export type CreateVisibilityPromptBody = z.infer<
  typeof createVisibilityPromptBodySchema
>;
export type CreateVisibilityPromptBodyInput = z.input<
  typeof createVisibilityPromptBodySchema
>;

export const updateVisibilityPromptBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    promptText: z.string().min(1).optional(),
    branded: z.boolean().optional(),
    brandA: z.string().nullish(),
    brandB: z.string().nullish(),
    marketId: z.string().nullish(),
    tags: z.array(z.string()).optional(),
    ...visibilityPromptSettingsPatchShape,
    scenarios: z.array(visibilityScenarioInputSchema).optional(),
  })
  .strict();
export type UpdateVisibilityPromptBody = z.infer<
  typeof updateVisibilityPromptBodySchema
>;

export { runVisibilityBodySchema };

export const runVisibilityPromptResponseSchema = z.object({
  batchIds: z.array(z.string()),
  runIds: z.array(z.string()),
});
export type RunVisibilityPromptResponse = z.infer<
  typeof runVisibilityPromptResponseSchema
>;

export const visibilityPromptRunSchema = z.object({
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
  verdict: z
    .object({
      status: z.string(),
      error: z.string().nullable(),
      payload: z.unknown().nullable(),
    })
    .nullable(),
});
export type VisibilityPromptRun = z.infer<typeof visibilityPromptRunSchema>;

export const listVisibilityPromptRunsResponseSchema = listResponseSchema(
  visibilityPromptRunSchema,
);
export type ListVisibilityPromptRunsResponse = z.infer<
  typeof listVisibilityPromptRunsResponseSchema
>;

export const orgMarketSchema = z.object({
  marketId: z.string(),
  slug: z.string(),
  name: z.string(),
  capability: z.string(),
  source: z.string(),
});
export type OrgMarket = z.infer<typeof orgMarketSchema>;

export const addableMarketSchema = orgMarketSchema.omit({ source: true });
export type AddableMarket = z.infer<typeof addableMarketSchema>;

export const listMarketsResponseSchema = z.object({
  tracked: z.array(orgMarketSchema),
  addable: z.array(addableMarketSchema),
});
export type ListMarketsResponse = z.infer<typeof listMarketsResponseSchema>;

export const addMarketBodySchema = z.object({ marketId: z.string().min(1) });
export type AddMarketBody = z.infer<typeof addMarketBodySchema>;
