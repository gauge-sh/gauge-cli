import { z } from "zod";

export const inviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  invitedBy: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type Invite = z.infer<typeof inviteSchema>;

export const listInvitesResponseSchema = z.object({
  items: z.array(inviteSchema),
});
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;
