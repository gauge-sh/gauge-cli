import { z } from "zod";

export const ACTION_STATUSES = ["OPEN", "RESOLVED", "DISMISSED"] as const;
export const actionStatusSchema = z.enum(ACTION_STATUSES);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

export const ACTION_PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export const actionPrioritySchema = z.enum(ACTION_PRIORITIES);
export type ActionPriority = z.infer<typeof actionPrioritySchema>;

export const actionEvidenceSchema = z.object({
  id: z.string(),
  runId: z.string(),
  note: z.string(),
  createdAt: z.string(),
});
export type ActionEvidence = z.infer<typeof actionEvidenceSchema>;

export const actionSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  kind: z.string().nullable(),
  priority: actionPrioritySchema,
  status: actionStatusSchema,
  sourceType: z.string(),
  resolutionNote: z.string().nullable(),
  lastEvidenceAt: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  evidenceCount: z.number().int(),
  evidence: z.array(actionEvidenceSchema),
});
export type Action = z.infer<typeof actionSchema>;

const csv = z.string().transform((s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);

export const listActionsQuerySchema = z.object({
  status: csv.pipe(z.array(actionStatusSchema)).optional(),
});
export type ListActionsQuery = z.infer<typeof listActionsQuerySchema>;

export const listActionsResponseSchema = z.object({
  items: z.array(actionSchema),
});
export type ListActionsResponse = z.infer<typeof listActionsResponseSchema>;

export const updateActionBodySchema = z.object({
  status: actionStatusSchema,
  note: z.string().max(2000).optional(),
});
export type UpdateActionBody = z.infer<typeof updateActionBodySchema>;
