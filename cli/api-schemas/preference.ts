import { z } from "zod";

export const preferenceDefinitionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("open-ended"),
      branded: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("head-to-head"),
      brandA: z.string().trim().min(1),
      brandB: z.string().trim().min(1),
    })
    .strict()
    .refine(
      (p) => p.brandA.toLowerCase() !== p.brandB.toLowerCase(),
      "A head-to-head needs two different brands",
    ),
]);
export type PreferenceDefinition = z.infer<typeof preferenceDefinitionSchema>;
export const preferenceSnapshotSchema = z
  .object({ version: z.literal(1), preference: preferenceDefinitionSchema })
  .strict();
export function preferenceAnalystMeta(p: PreferenceDefinition) {
  return p.kind === "head-to-head"
    ? {
        kind: "HEAD_TO_HEAD" as const,
        branded: true,
        brandA: p.brandA,
        brandB: p.brandB,
      }
    : {
        kind: "RECOMMEND" as const,
        branded: p.branded,
        brandA: null,
        brandB: null,
      };
}

export type VisibilityKind = "HEAD_TO_HEAD" | "RECOMMEND";

export type HeadToHeadWinner = "A" | "B" | "both" | "neither";

const headToHeadSchema = z.object({
  kind: z.literal("HEAD_TO_HEAD"),
  assessability: z.enum(["assessed", "partial", "unassessable"]).optional(),
  selectionStatus: z
    .enum(["measured", "not_measured", "unassessable"])
    .optional(),
  winner: z.enum(["A", "B", "both", "neither"]),
  brandA: z.string(),
  brandB: z.string(),
  rationale: z.string(),
  brandAReasoning: z.string(),
  brandBReasoning: z.string(),
  brandAWhyRaised: z.string().optional(),
  brandBWhyRaised: z.string().optional(),
});

const recommendPickSchema = z.object({
  brand: z.string(),
  rank: z.number().int(),
  adopted: z.boolean(),
  reasoning: z.string().optional(),
  whyRaised: z.string().optional(),
});

const recommendSchema = z.object({
  kind: z.literal("RECOMMEND"),
  selectedBrands: z.array(z.string()).optional(),
  assessability: z.enum(["assessed", "partial", "unassessable"]).optional(),
  selectionStatus: z
    .enum(["measured", "not_measured", "unassessable"])
    .optional(),
  picks: z.array(recommendPickSchema).default([]),
  singlePick: z.boolean(),
  complianceNote: z.string(),
});

export const visibilityVerdictSchema = z.discriminatedUnion("kind", [
  headToHeadSchema,
  recommendSchema,
]);

export type HeadToHeadVerdict = z.infer<typeof headToHeadSchema>;
export type RecommendPickView = z.infer<typeof recommendPickSchema>;
export type RecommendVerdict = z.infer<typeof recommendSchema>;
export type VisibilityVerdict = z.infer<typeof visibilityVerdictSchema>;

export function preferenceSelectionLabel(verdict: VisibilityVerdict): string {
  if (
    verdict.assessability === "unassessable" ||
    verdict.selectionStatus === "unassessable"
  )
    return "Not assessable";
  if (verdict.kind === "HEAD_TO_HEAD")
    return verdict.winner === "A"
      ? verdict.brandA
      : verdict.winner === "B"
        ? verdict.brandB
        : verdict.winner === "both"
          ? `${verdict.brandA} and ${verdict.brandB}`
          : "Neither";
  if (verdict.selectedBrands !== undefined)
    return verdict.selectedBrands.length
      ? verdict.selectedBrands.join(", ")
      : "No selection";
  if (!verdict.singlePick)
    return verdict.picks.length ? "No clear selection" : "No selection";
  return verdict.picks.find((pick) => pick.rank === 1)?.brand ?? "No selection";
}
