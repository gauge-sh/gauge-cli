import { z } from "zod";
import { lifecycleSchema } from "./lifecycle";
import {
  agentConfigInputSchema,
  agentConfigSchema,
  assetRefListSchema,
} from "./runConfig";

const sampleCountSchema = z.number().int().min(1).max(50);

export const nextRunAtInputSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "Next run must be a calendar date")
  .nullable();

export const ownedCadenceSchema = z.enum([
  "NONE",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
]);

export const ownedConfigurationInputShape = {
  repoUrl: z.string().nullish(),
  repoRef: z.string().nullish(),
  profileId: z.string().nullish(),
  agents: z.array(agentConfigInputSchema).min(1, "Select at least one agent"),
  skillRefs: assetRefListSchema.optional().default([]),
  mcpRefs: assetRefListSchema.optional().default([]),
  connectionIds: z.array(z.string().min(1)).max(32).optional().default([]),
  lifecycle: lifecycleSchema.nullish(),
  cadence: ownedCadenceSchema.optional().default("NONE"),
  nextRunAt: nextRunAtInputSchema.optional(),
  sampleCount: sampleCountSchema.optional().default(1),
} as const;

export const ownedConfigurationInputSchema = z
  .object(ownedConfigurationInputShape)
  .strict();
export type OwnedConfigurationInput = z.input<
  typeof ownedConfigurationInputSchema
>;
export type OwnedConfigurationBody = z.infer<
  typeof ownedConfigurationInputSchema
>;

export const ownedConfigurationPatchShape = {
  repoUrl: z.string().nullish(),
  repoRef: z.string().nullish(),
  profileId: z.string().nullish(),
  agents: z
    .array(agentConfigInputSchema)
    .min(1, "Select at least one agent")
    .optional(),
  skillRefs: assetRefListSchema.optional(),
  mcpRefs: assetRefListSchema.optional(),
  connectionIds: z.array(z.string().min(1)).max(32).optional(),
  lifecycle: lifecycleSchema.nullish(),
  cadence: ownedCadenceSchema.optional(),
  nextRunAt: nextRunAtInputSchema.optional(),
  sampleCount: sampleCountSchema.optional(),
} as const;

export const ownedConfigurationSchema = z.object({
  repoUrl: z.string().nullable(),
  repoRef: z.string().nullable(),
  profile: z.object({ id: z.string(), name: z.string() }).nullable(),
  agents: z.array(agentConfigSchema),
  skillRefs: z.array(z.string()),
  mcpRefs: z.array(z.string()),
  connectionIds: z.array(z.string()),
  lifecycle: lifecycleSchema.nullish(),
  cadence: ownedCadenceSchema,
  sampleCount: sampleCountSchema,
  lastScheduledAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
});
export type OwnedConfiguration = z.infer<typeof ownedConfigurationSchema>;

export const visibilityScenarioSchema = z.object({
  id: z.string(),
  repoUrl: z.string().nullable(),
  repoRef: z.string().nullable(),
  profile: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type VisibilityScenario = z.infer<typeof visibilityScenarioSchema>;

export const visibilityScenarioInputSchema = z
  .object({
    repoUrl: z.string().nullish(),
    repoRef: z.string().nullish(),
    profileId: z.string().nullish(),
  })
  .strict();
export type VisibilityScenarioInput = z.input<
  typeof visibilityScenarioInputSchema
>;

export const visibilityPromptSettingsInputShape = {
  agents: ownedConfigurationInputShape.agents,
  skillRefs: ownedConfigurationInputShape.skillRefs,
  mcpRefs: ownedConfigurationInputShape.mcpRefs,
  connectionIds: ownedConfigurationInputShape.connectionIds,
  lifecycle: ownedConfigurationInputShape.lifecycle,
  cadence: ownedConfigurationInputShape.cadence,
  nextRunAt: ownedConfigurationInputShape.nextRunAt,
  sampleCount: ownedConfigurationInputShape.sampleCount,
} as const;

export const visibilityPromptSettingsPatchShape = {
  agents: ownedConfigurationPatchShape.agents,
  skillRefs: ownedConfigurationPatchShape.skillRefs,
  mcpRefs: ownedConfigurationPatchShape.mcpRefs,
  connectionIds: ownedConfigurationPatchShape.connectionIds,
  lifecycle: ownedConfigurationPatchShape.lifecycle,
  cadence: ownedConfigurationPatchShape.cadence,
  nextRunAt: ownedConfigurationPatchShape.nextRunAt,
  sampleCount: ownedConfigurationPatchShape.sampleCount,
} as const;

export const visibilityPromptSettingsSchema = z.object({
  agents: z.array(agentConfigSchema),
  skillRefs: z.array(z.string()),
  mcpRefs: z.array(z.string()),
  connectionIds: z.array(z.string()),
  lifecycle: lifecycleSchema.nullish(),
  cadence: ownedCadenceSchema,
  sampleCount: sampleCountSchema,
  lastScheduledAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
});
export type VisibilityPromptSettings = z.infer<
  typeof visibilityPromptSettingsSchema
>;

export const runAgentsOverrideSchema = z
  .array(agentConfigInputSchema)
  .min(1, "Select at least one agent");
export type RunAgentsOverride = z.input<typeof runAgentsOverrideSchema>;

export const runSampleCountOverrideSchema = sampleCountSchema;

export const runEvalBodySchema = z
  .object({
    agents: runAgentsOverrideSchema.optional(),
    sampleCount: runSampleCountOverrideSchema.optional(),
  })
  .strict();
export const runVisibilityBodySchema = z
  .object({
    agents: runAgentsOverrideSchema.optional(),
    sampleCount: runSampleCountOverrideSchema.optional(),
    visibilityScenarioIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
