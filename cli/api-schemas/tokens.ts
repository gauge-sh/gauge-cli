import { z } from "zod";
import { listResponseSchema } from "./common";

export const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  last4: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiTokenItem = z.infer<typeof apiTokenSchema>;

export const createTokenRequestSchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateTokenRequest = z.infer<typeof createTokenRequestSchema>;

export const createTokenResponseSchema = apiTokenSchema.extend({
  token: z.string(),
});
export type CreateTokenResponse = z.infer<typeof createTokenResponseSchema>;

export const listTokensResponseSchema = listResponseSchema(apiTokenSchema);
export type ListTokensResponse = z.infer<typeof listTokensResponseSchema>;
