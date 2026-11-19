import { z } from "zod";

export const journeySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  default: z.boolean(),
  evalCount: z.number().int(),
  createdAt: z.string(),
});
export type Journey = z.infer<typeof journeySchema>;

export const listJourneysResponseSchema = z.object({
  items: z.array(journeySchema),
});
export type ListJourneysResponse = z.infer<typeof listJourneysResponseSchema>;

export const createJourneyBodySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();
export type CreateJourneyBody = z.infer<typeof createJourneyBodySchema>;

export const updateJourneyBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .strict();
export type UpdateJourneyBody = z.infer<typeof updateJourneyBodySchema>;
