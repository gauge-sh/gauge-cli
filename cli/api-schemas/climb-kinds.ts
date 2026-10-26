import { z } from "zod";
export const LEVER_KINDS = [
  "DOCS",
  "MARKETING_SITE",
  "SDK",
  "CLI",
  "SKILL",
] as const;
export type LeverKind = (typeof LEVER_KINDS)[number];

export const TRIAL_KINDS = ["BASELINE", "CHANGE"] as const;
export type TrialKind = (typeof TRIAL_KINDS)[number];

export const INTERVENTION_KINDS = [
  "ADD_SKILL",
  "REMOVE_SKILL",
  "EDIT_SKILL",
  "REWRITE_DOCS",
  "PACKAGE_VERSION",
  "PACKAGE_CONTENT",
  "CLI_VERSION",
  "CLI_INTERVENTION",
] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

export const LEVER_INTERVENTIONS = {
  DOCS: ["REWRITE_DOCS"],
  MARKETING_SITE: ["REWRITE_DOCS"],
  SDK: ["PACKAGE_VERSION", "PACKAGE_CONTENT"],
  CLI: ["CLI_INTERVENTION"],
  SKILL: ["ADD_SKILL", "REMOVE_SKILL", "EDIT_SKILL"],
} as const satisfies Record<LeverKind, readonly InterventionKind[]>;

export function leversOfIntervention(kind: InterventionKind): LeverKind[] {
  return LEVER_KINDS.filter((lever) =>
    (LEVER_INTERVENTIONS[lever] as readonly InterventionKind[]).includes(kind),
  );
}

export const targetRefSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().optional(),
    url: z.url().optional(),
    package: z.string().optional(),
  })
  .strict();
export type TargetRef = z.infer<typeof targetRefSchema>;
