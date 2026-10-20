import { z } from "zod";

export const runAddonsSchema = z
  .object({
    browser: z
      .object({
        session: z.string().min(1),
        projectId: z.number().int().positive(),
        region: z.literal("us").default("us"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RunAddons = z.infer<typeof runAddonsSchema>;
