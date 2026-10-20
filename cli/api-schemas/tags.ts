import { z } from "zod";
import { listQuerySchema, listResponseSchema } from "./common";

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});
export type Tag = z.infer<typeof tagSchema>;

export const createTagBodySchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
});
export type CreateTagBody = z.infer<typeof createTagBodySchema>;

export const updateTagBodySchema = z.object({
  name: z.string().min(1).optional(),
  color: z.string().optional(),
});
export type UpdateTagBody = z.infer<typeof updateTagBodySchema>;

export const listTagsQuerySchema = listQuerySchema;
export const tagListResponseSchema = listResponseSchema(tagSchema);
