import { z } from "zod";

export const FEEDBACK_KINDS = ["friction", "missing", "bug", "other"] as const;
export const feedbackKindSchema = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof feedbackKindSchema>;

export const createFeedbackBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  kind: feedbackKindSchema.default("other"),
  command: z.string().trim().max(500).optional(),
  org: z.string().optional(),
});
export type CreateFeedbackBody = z.input<typeof createFeedbackBodySchema>;

export const createFeedbackResponseSchema = z.object({
  id: z.string(),
});
export type CreateFeedbackResponse = z.infer<
  typeof createFeedbackResponseSchema
>;
