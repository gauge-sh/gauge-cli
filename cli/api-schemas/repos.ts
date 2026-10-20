import { z } from "zod";
import { listResponseSchema } from "./common";

export const REPO_SIZE_BUCKETS = [
  "small",
  "medium",
  "large",
  "xlarge",
] as const;
export const repoSizeBucketSchema = z.enum(REPO_SIZE_BUCKETS);
export type RepoSizeBucket = z.infer<typeof repoSizeBucketSchema>;

export const repoSchema = z.object({
  url: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  tags: z.array(z.string()),
  primaryLanguage: z.string(),
  sizeKb: z.number(),
  sizeBucket: repoSizeBucketSchema.nullable(),
  stars: z.number(),
});
export type Repo = z.infer<typeof repoSchema>;

export const repoListResponseSchema = listResponseSchema(repoSchema);
export type RepoListResponse = z.infer<typeof repoListResponseSchema>;

export const addRepoBodySchema = z.object({
  url: z.string().min(1, "url is required"),
  ref: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  frameworks: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
export type AddRepoBody = z.infer<typeof addRepoBodySchema>;

export const updateRepoBodySchema = z.object({
  url: z.string().min(1, "url is required"),
  name: z.string().min(1).optional(),
  frameworks: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
export type UpdateRepoBody = z.infer<typeof updateRepoBodySchema>;

export const resyncRepoBodySchema = z.object({
  url: z.string().min(1, "url is required"),
});
export type ResyncRepoBody = z.infer<typeof resyncRepoBodySchema>;

export const deleteRepoQuerySchema = z.object({
  url: z.string().min(1, "url is required"),
});
export type DeleteRepoQuery = z.infer<typeof deleteRepoQuerySchema>;

export const repoSyncResultSchema = z.object({
  repo: repoSchema,
  synced: z.boolean(),
});
export type RepoSyncResult = z.infer<typeof repoSyncResultSchema>;
