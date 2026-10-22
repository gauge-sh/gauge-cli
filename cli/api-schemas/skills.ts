import { z } from "zod";

const sha256Hex = z.custom<`sha256:${string}`>(
  (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value),
  "expected a sha256:<64 lowercase hex> digest",
);

export const skillHandleSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "invalid skill handle")
  .refine((name) => name !== "." && name !== "..", "invalid skill handle");

export const skillSetEntrySchema = z.object({
  skillId: z.string().min(1),
  name: skillHandleSchema,
  label: z.string().min(1),
  contentDigest: sha256Hex,
  blobDigest: sha256Hex,
  blobKey: z.string().min(1),
  rawBytes: z.number().int().positive().optional(),
  storedBytes: z.number().int().positive().optional(),
  exposure: z.record(z.string(), z.unknown()).optional(),
});

export const skillSetSchema = z.array(skillSetEntrySchema);

export type SkillSetEntry = z.infer<typeof skillSetEntrySchema>;
export type SkillSet = z.infer<typeof skillSetSchema>;

export const skillSourceWireSchema = z.object({
  repoFullName: z.string(),
  ref: z.string(),
  subpath: z.string(),
  autoIngest: z.boolean(),
  lastSeenCommit: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type SkillSourceWire = z.infer<typeof skillSourceWireSchema>;

export const skillVersionWireSchema = z.object({
  id: z.string(),
  label: z.string(),
  contentDigest: z.string(),
  ingestTrigger: z.string().nullable(),
  createdAt: z.string(),
});
export type SkillVersionWire = z.infer<typeof skillVersionWireSchema>;

export const skillListItemSchema = z.object({
  id: z.string(),
  name: skillHandleSchema,
  note: z.string().nullable(),
  source: skillSourceWireSchema.nullable(),
  latestVersion: skillVersionWireSchema.nullable(),
  versionCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SkillListItem = z.infer<typeof skillListItemSchema>;

export const listSkillsResponseSchema = z.object({
  items: z.array(skillListItemSchema),
});
export type ListSkillsResponse = z.infer<typeof listSkillsResponseSchema>;

export const skillDetailSchema = skillListItemSchema
  .omit({ latestVersion: true })
  .extend({ versions: z.array(skillVersionWireSchema) });
export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const addSkillBodySchema = z.object({
  reference: z.string().min(1),
  handle: skillHandleSchema.optional(),
  label: z.string().min(1).max(120).optional(),
  skill: z.string().min(1).optional(),
  note: z.string().max(2000).optional(),
  trackSource: z.boolean().optional(),
});
export type AddSkillBody = z.infer<typeof addSkillBodySchema>;

export const addSkillResponseSchema = z.object({
  skillId: z.string().nullable(),
  handle: z.string(),
  label: z.string(),
  unchanged: z.boolean(),
});
export type AddSkillResponse = z.infer<typeof addSkillResponseSchema>;

export const updateSkillBodySchema = z.object({
  name: skillHandleSchema.optional(),
  note: z.string().max(2000).nullish(),
  source: z
    .object({
      repoFullName: z.string().min(1),
      ref: z.string().min(1),
      subpath: z.string().optional(),
      autoIngest: z.boolean().optional(),
    })
    .nullish(),
});
export type UpdateSkillBody = z.infer<typeof updateSkillBodySchema>;

export const reingestSkillResponseSchema = z.object({
  label: z.string().nullable(),
  unchanged: z.boolean(),
});
export type ReingestSkillResponse = z.infer<typeof reingestSkillResponseSchema>;

export const addSkillVersionBodySchema = z.object({
  reference: z.string().min(1),
  label: z.string().min(1).max(120).optional(),
});
export type AddSkillVersionBody = z.infer<typeof addSkillVersionBodySchema>;

export const addSkillVersionResponseSchema = z.object({
  label: z.string(),
  unchanged: z.boolean(),
});
export type AddSkillVersionResponse = z.infer<
  typeof addSkillVersionResponseSchema
>;

export const skillRunWireSchema = z.object({
  runId: z.string(),
  agent: z.string(),
  turns: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  finishedAt: z.string().nullable(),
  versionLabel: z.string().nullable(),
});
export type SkillRunWire = z.infer<typeof skillRunWireSchema>;

export const listSkillRunsResponseSchema = z.object({
  items: z.array(skillRunWireSchema),
});
export type ListSkillRunsResponse = z.infer<typeof listSkillRunsResponseSchema>;
