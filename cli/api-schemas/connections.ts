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
  /** HTTP Basic with a username/password pair; the credential is the pair. */
  z
    .object({ style: z.literal("basic") })
    .strict(),
]);
export type ConnectionHostAuth = z.infer<typeof connectionHostAuthSchema>;

const connectionHandleInputSchema = z.string().min(1).max(128);
const connectionHostInputSchema = z.string().min(1).max(2048);

/**
 * Everything about a host connection except its value: where the credential
 * may be sent and what agents see. Shared by create and preview so the two can
 * never describe different connections.
 */
const hostConnectionShape = {
  handle: connectionHandleInputSchema,
  /** A bare hostname or an https:// URL; only the host is stored. */
  host: connectionHostInputSchema,
  /** More exact hosts that may receive the same credential. */
  additionalHosts: z.array(connectionHostInputSchema).max(31).optional(),
  /** Defaults to the host. */
  displayName: z.string().min(1).max(60).optional(),
  /**
   * How the host receives the credential. Omitted means "recognize a built-in
   * vendor from the hosts, otherwise bearer" (or Basic for a username/password
   * pair).
   */
  auth: connectionHostAuthSchema.optional(),
  /** The environment variable agents see. Omitted means derived. */
  credentialKey: credentialEnvKeySchema.optional(),
  /** The password's environment variable for a Basic pair. */
  basicPasswordKey: credentialEnvKeySchema.optional(),
};

/**
 * POST /api/v1/orgs/{org}/connections. A custom host (`host`, plus how it
 * takes the credential), or the deprecated `profileSlug` for a built-in vendor.
 * A host that belongs to a built-in vendor is recognized from the host.
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
      ...hostConnectionShape,
      credential: connectionCredentialInputSchema,
    })
    .strict(),
]);
export type CreateConnectionBody = z.infer<typeof createConnectionBodySchema>;

/**
 * POST /api/v1/orgs/{org}/connections/preview. The same request without the
 * credential: answers what a create would store, so a client can show it
 * before asking for the value. `paired` stands in for a username/password
 * credential.
 */
export const previewConnectionBodySchema = z
  .object({
    ...hostConnectionShape,
    paired: z.boolean().optional(),
  })
  .strict();
export type PreviewConnectionBody = z.infer<typeof previewConnectionBodySchema>;

export const connectionPreviewSchema = z
  .object({
    handle: z.string(),
    /** The built-in vendor recognized from the hosts, or null. */
    builtIn: z.string().nullable(),
    allowedHosts: z.array(z.string()),
    credentialKey: z.string(),
    basicPasswordKey: credentialEnvKeySchema.nullable(),
  })
  .strict();
export type ConnectionPreview = z.infer<typeof connectionPreviewSchema>;

/** DELETE /api/v1/orgs/{org}/connections/{id} */
export const deleteConnectionResponseSchema = z
  .object({ id: z.string(), deleted: z.literal(true) })
  .strict();
export type DeleteConnectionResponse = z.infer<
  typeof deleteConnectionResponseSchema
>;
