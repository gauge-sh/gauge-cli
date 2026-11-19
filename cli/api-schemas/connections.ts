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

const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
const parameterNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/);

/**
 * A credential value as a write accepts it: one key, or the username/password
 * pair a Basic profile presents.
 */
export const connectionCredentialInputSchema = z.union([
  z.string().min(1).max(16_384),
  z
    .object({
      username: z.string().max(4096),
      password: z.string().max(4096),
    })
    .strict(),
]);
export type ConnectionCredentialInput = z.infer<
  typeof connectionCredentialInputSchema
>;

/** PUT /api/v1/orgs/{org}/connections/{id}/credential */
export const rotateConnectionCredentialBodySchema = z
  .object({ credential: connectionCredentialInputSchema })
  .strict();
export type RotateConnectionCredentialBody = z.infer<
  typeof rotateConnectionCredentialBodySchema
>;

/** How a custom host receives the credential. */
export const connectionHostAuthSchema = z.discriminatedUnion("style", [
  z.object({ style: z.literal("bearer") }).strict(),
  z
    .object({
      style: z.literal("header"),
      headerName: headerNameSchema,
      valuePrefix: z.string().max(256).optional(),
    })
    .strict(),
  z
    .object({ style: z.literal("query"), queryParam: parameterNameSchema })
    .strict(),
]);
export type ConnectionHostAuth = z.infer<typeof connectionHostAuthSchema>;

const connectionHandleInputSchema = z.string().min(1).max(128);

/**
 * POST /api/v1/orgs/{org}/connections. Exactly one of a built-in profile
 * (`profileSlug`) or a custom host (`host`, plus how it takes the credential).
 */
export const createConnectionBodySchema = z.union([
  z
    .object({
      handle: connectionHandleInputSchema,
      profileSlug: z.string().min(1).max(128),
      credential: connectionCredentialInputSchema,
    })
    .strict(),
  z
    .object({
      handle: connectionHandleInputSchema,
      /** A bare hostname or an https:// URL; only the host is stored. */
      host: z.string().min(1).max(2048),
      /** Defaults to the host. */
      displayName: z.string().min(1).max(60).optional(),
      auth: connectionHostAuthSchema,
      credential: z.string().min(1).max(16_384),
    })
    .strict(),
]);
export type CreateConnectionBody = z.infer<typeof createConnectionBodySchema>;

/** DELETE /api/v1/orgs/{org}/connections/{id} */
export const deleteConnectionResponseSchema = z
  .object({ id: z.string(), deleted: z.literal(true) })
  .strict();
export type DeleteConnectionResponse = z.infer<
  typeof deleteConnectionResponseSchema
>;
