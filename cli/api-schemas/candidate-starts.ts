import { z } from "zod";

const slot = {
  configurationIndex: z.number().int().nonnegative(),
  repetitionIndex: z.number().int().nonnegative(),
};

export const candidateStartSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...slot,
      kind: z.literal("checkpoint"),
      checkpointId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...slot,
      kind: z.literal("fresh"),
      reason: z.string().min(1).max(1024),
    })
    .strict(),
]);
export const candidateStartsSchema = z
  .array(candidateStartSchema)
  .refine(
    (rows) =>
      new Set(
        rows.map((row) => `${row.configurationIndex}:${row.repetitionIndex}`),
      ).size === rows.length,
    "Each candidate run has one starting point",
  );
export type CandidateStart = z.infer<typeof candidateStartSchema>;
