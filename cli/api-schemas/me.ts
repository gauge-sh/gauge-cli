import { z } from "zod";

export const meUserSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
});
export type MeUser = z.infer<typeof meUserSchema>;

export const meOrgSchema = z.object({
  slug: z.string(),
  publicId: z.string().nullable(),
  // The shared Gauge organization id; null for LOCAL and unlinked workspaces,
  // absent from older servers.
  canonicalGaugeOrganizationId: z.string().nullable().optional(),
  name: z.string(),
});
export type MeOrg = z.infer<typeof meOrgSchema>;

export const meResponseSchema = z.object({
  user: meUserSchema,
  orgs: z.array(meOrgSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
