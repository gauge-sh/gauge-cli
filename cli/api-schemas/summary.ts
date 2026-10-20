import { z } from "zod";

export function cardResultSchema<T extends z.ZodType>(data: T) {
  return z.union([
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]);
}
export type CardResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export const summaryActionSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.string(),
  status: z.string(),
  evidenceCount: z.number().int(),
});

export const summaryAeCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  judgedRuns: z.number().int(),
  passRate: z.number().nullable(),
  deltaPP: z.number().nullable(),
});

export const summaryVisibilityCardSchema = z.object({
  name: z.string(),
  owned: z
    .object({
      name: z.string(),
      rank: z.number(),
      chosenRate: z.number(),
      mentionRate: z.number(),
    })
    .nullable(),
  chosenDeltaPP: z.number().nullable(),
});

export const homeSummarySchema = z.object({
  hasAnyRuns: z.boolean(),
  lastSynthesisAt: z.string().nullable(),
  actions: cardResultSchema(z.array(summaryActionSchema)),
  visibility: cardResultSchema(
    z.object({
      cards: z.array(summaryVisibilityCardSchema),
      marketsTotal: z.number().int(),
      promptCount: z.number().int(),
    }),
  ),
  agentExperience: cardResultSchema(
    z.object({
      cards: z.array(summaryAeCardSchema),
      total: z.number().int(),
      setCount: z.number().int(),
    }),
  ),
  notableSessions: cardResultSchema(z.array(z.unknown())),
});
export type HomeSummary = z.infer<typeof homeSummarySchema>;
