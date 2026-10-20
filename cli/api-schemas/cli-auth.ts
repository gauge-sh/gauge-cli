import { z } from "zod";

export const PKCE_S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export const cliAuthorizationTokenRequestSchema = z.object({
  code: z.string().min(1).max(512),
  codeVerifier: z.string().regex(PKCE_VERIFIER_PATTERN),
});
export type CliAuthorizationTokenRequest = z.infer<
  typeof cliAuthorizationTokenRequestSchema
>;

export const cliAuthorizationTokenResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal("bearer"),
  expiresAt: z.string().nullable(),
});
export type CliAuthorizationTokenResponse = z.infer<
  typeof cliAuthorizationTokenResponseSchema
>;
