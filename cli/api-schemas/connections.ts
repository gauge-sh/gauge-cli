import { z } from "zod";

const credentialEnvKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/);

export const connectionSummarySchema = z
  .object({
    id: z.string(),
    handle: z.string(),
    providerName: z.string(),
    credentialKey: z.string(),
    basicPasswordKey: credentialEnvKeySchema.nullable().optional(),
    allowedHosts: z.array(z.string()),
    profileSlug: z.string(),
    profileLabel: z.string(),
    kind: z.enum(["static", "oauth"]),
    last4: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>;

export const listConnectionsResponseSchema = z
  .object({ items: z.array(connectionSummarySchema) })
  .strict();
export type ListConnectionsResponse = z.infer<
  typeof listConnectionsResponseSchema
>;
