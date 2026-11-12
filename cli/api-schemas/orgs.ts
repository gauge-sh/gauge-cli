import { z } from "zod";

export const createOrgRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  website: z.string().trim().max(300).optional(),
});
export type CreateOrgRequest = z.infer<typeof createOrgRequestSchema>;

export const createOrgResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  publicId: z.string().nullable(),
});
export type CreateOrgResponse = z.infer<typeof createOrgResponseSchema>;

export const PREFERENCE_SCHEDULE_CADENCES = ["DAILY", "WEEKLY"] as const;

export const preferenceScheduleSchema = z.object({
  cadence: z.enum(PREFERENCE_SCHEDULE_CADENCES),
  weeklyRunDay: z.number().int().min(0).max(6),
  nextRunAt: z.string().nullable(),
});
export type PreferenceSchedule = z.infer<typeof preferenceScheduleSchema>;

export const updatePreferenceScheduleBodySchema = preferenceScheduleSchema
  .pick({ cadence: true, weeklyRunDay: true })
  .partial()
  .strict();
export type UpdatePreferenceScheduleBody = z.infer<
  typeof updatePreferenceScheduleBodySchema
>;

export const orgSettingsSchema = z.object({
  slug: z.string(),
  name: z.string(),
  publicId: z.string().nullable(),
  website: z.string().nullable(),
  maxSpendUsd: z.number().nullable(),
  overageEnabled: z.boolean(),
  overageCapCredits: z.number().int().nullable(),
  autoJoinDomain: z.string().nullable(),
  preferenceSchedule: preferenceScheduleSchema.optional(),
});
export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export const orgMemberSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  joinedAt: z.string(),
});
export type OrgMember = z.infer<typeof orgMemberSchema>;

export const listMembersResponseSchema = z.object({
  items: z.array(orgMemberSchema),
});
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;
