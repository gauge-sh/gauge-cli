import { z } from "zod";
import { agentSchema } from "./runs";

export const executionTargetCapabilitiesSchema = z.object({
  skills: z.boolean(),
  mcp: z.boolean(),
  connections: z.boolean(),
  agentContext: z.boolean(),
  resume: z.boolean(),
});
export type ExecutionTargetCapabilities = z.infer<
  typeof executionTargetCapabilitiesSchema
>;

export const executionTargetSchema = z.object({
  harness: agentSchema,
  harnessSlug: z.string(),
  harnessLabel: z.string(),
  model: z.string(),
  modelLabel: z.string(),
  providerSlug: z.string(),
  providerLabel: z.string(),
  capabilities: executionTargetCapabilitiesSchema,
});
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

export const executionTargetsResponseSchema = z.object({
  items: z.array(executionTargetSchema),
});
export type ExecutionTargetsResponse = z.infer<
  typeof executionTargetsResponseSchema
>;
