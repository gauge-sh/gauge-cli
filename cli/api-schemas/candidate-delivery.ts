import { z } from "zod";

export const candidateDeliverySchema = z.object({
  runId: z.string(),
  attempt: z.number().int().nonnegative(),
  surface: z.enum(["docs", "cli"]),
  candidateDigest: z.string(),
  installed: z.boolean(),
  evidenceComplete: z.boolean(),
  exposure: z.enum(["exercised", "partial", "not_exercised", "unknown"]),
  deliveryFailures: z.number().int().nonnegative(),
  observedArtifacts: z.array(z.string()).max(512),
  expectedArtifacts: z.array(z.string()).max(512),
});
export type CandidateDelivery = z.infer<typeof candidateDeliverySchema>;
