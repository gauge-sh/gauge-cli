import { z } from "zod";
import { listResponseSchema } from "./common";

export const PROVIDER_TYPES = ["anthropic", "openai"] as const;
export const providerTypeSchema = z.enum(PROVIDER_TYPES);
export type ProviderType = z.infer<typeof providerTypeSchema>;

export const setProviderKeyBodySchema = z.object({
  key: z.string().min(1),
});
export type SetProviderKeyBody = z.infer<typeof setProviderKeyBodySchema>;

export const setProviderKeyResponseSchema = z.object({
  providerType: providerTypeSchema,
  last4: z.string(),
});
export type SetProviderKeyResponse = z.infer<
  typeof setProviderKeyResponseSchema
>;

export const providerKeySchema = z.object({
  providerType: providerTypeSchema,
  last4: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProviderKey = z.infer<typeof providerKeySchema>;

export const providerKeyListResponseSchema =
  listResponseSchema(providerKeySchema);
