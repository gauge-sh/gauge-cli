import { z } from "zod";
import { agentSchema as runAgentSchema } from "./runs";

export const SCHEDULABLE_AGENTS = [
  "CLAUDE_CODE",
  "CODEX_CLI",
  "PI",
  "OPENCODE",
] as const;
export const schedulableAgentSchema = z.enum(SCHEDULABLE_AGENTS);
export type SchedulableAgent = z.infer<typeof schedulableAgentSchema>;

// The wire contract includes enrolled harnesses; the server checks org access.
export const ROSTERABLE_AGENTS = [
  ...SCHEDULABLE_AGENTS,
  "ANTIGRAVITY",
] as const;
export const rosterableAgentSchema = z.enum(ROSTERABLE_AGENTS);
export type RosterableAgent = z.infer<typeof rosterableAgentSchema>;

export const agentConfigSchema = z.object({
  agent: runAgentSchema,
  models: z.array(z.string().min(1)),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const agentConfigInputSchema = z.object({
  agent: rosterableAgentSchema,
  models: z.array(z.string().min(1)).default([]),
});
export type AgentConfigInput = z.input<typeof agentConfigInputSchema>;

export const assetRefSchema = z
  .string()
  .max(320)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*@[^\s,]+$/,
    'asset references must be "name@label"',
  );

export function refAssetName(ref: string): string {
  const at = ref.indexOf("@");
  return at < 0 ? ref : ref.slice(0, at);
}

export const assetRefListSchema = z
  .array(assetRefSchema)
  .superRefine((refs, ctx) => {
    const names = new Set<string>();
    for (const ref of refs) {
      const name = refAssetName(ref);
      if (names.has(name)) {
        ctx.addIssue({
          code: "custom",
          message: `"${ref}" names an asset already referenced — one version per asset`,
        });
      }
      names.add(name);
    }
  });

export function modelUnits(agents: { models: string[] }[]): number {
  return agents.reduce((n, a) => n + Math.max(1, a.models.length), 0);
}

export function runsPerCycle(
  owner: { agents: { models: string[] }[] },
  samplesPerCycle: number,
): number {
  return modelUnits(owner.agents) * samplesPerCycle;
}

export function totalRunsPerCycle(
  owners: { agents: { models: string[] }[] }[],
  samplesPerCycle: number,
): number {
  return owners.reduce((n, o) => n + runsPerCycle(o, samplesPerCycle), 0);
}
