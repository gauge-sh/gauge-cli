import { z } from "zod";
import { readConfig } from "./config";
import {
  readCredentials,
  saveCredentials,
  withCredentialLock,
  type SharedCredentials,
} from "./credentials";
export const DEFAULT_AUTH_URL = "https://app.withgauge.com";
// Opt in until both services have deployed shared auth.
export function sharedLoginEnabled(): boolean {
  return Boolean(process.env.GAUGE_AUTH_URL || readConfig().authUrl);
}
export function resolveAuthUrl(): string {
  return (
    process.env.GAUGE_AUTH_URL ||
    readConfig().authUrl ||
    DEFAULT_AUTH_URL
  ).replace(/\/+$/, "");
}
export const sharedTokenSchema = z.object({
  accessToken: z.string().startsWith("gauge_cli_"),
  refreshToken: z.string().startsWith("gauge_refresh_"),
  tokenType: z.literal("bearer"),
  expiresAt: z.iso.datetime({ offset: true }),
  refreshExpiresAt: z.iso.datetime({ offset: true }),
});
export function storedSharedCredentials(): SharedCredentials | null {
  if (process.env.GAUGE_API_TOKEN?.trim()) return null;
  const stored = readCredentials();
  return stored && typeof stored !== "string" ? stored : null;
}
export function assertTrustedOrigin(
  baseUrl: string,
  credentials: SharedCredentials,
): void {
  const origin = new URL(baseUrl).origin;
  if (
    ![credentials.authUrl, credentials.apiUrl].some(
      (value) => new URL(value).origin === origin,
    )
  )
    throw new Error(
      "Stored shared credentials are not authorized for this API origin. Log in explicitly for this host.",
    );
}
export class RefreshError extends Error {
  constructor(
    message: string,
    readonly unauthorized = false,
  ) {
    super(message);
  }
}
export async function refreshCredentials(
  previous: SharedCredentials,
  force = false,
): Promise<SharedCredentials> {
  return withCredentialLock(async () => {
    const current = readCredentials();
    if (!current || typeof current === "string")
      throw new Error("Credentials changed. Retry the command.");
    if (
      current.sessionId !== previous.sessionId ||
      current.authUrl !== previous.authUrl ||
      current.apiUrl !== previous.apiUrl
    )
      throw new Error(
        "Login changed while this command was running. Retry the command.",
      );
    if (current.accessToken !== previous.accessToken) return current;
    if (!current.refreshToken) return current;
    if (!force && Date.parse(current.expiresAt ?? "") > Date.now() + 60_000)
      return current;
    let response: Response;
    try {
      response = await fetch(`${current.authUrl}/api/cli/refresh`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
    } catch (error) {
      throw new RefreshError(
        `Credential refresh failed: ${error instanceof Error ? error.message : String(error)}. If the response was lost after rotation, run gauge auth login.`,
      );
    }
    if (!response.ok)
      throw new RefreshError(
        `Credential refresh failed (HTTP ${response.status}). ${response.status === 401 ? "Run gauge auth login." : "Retry when Gauge Chat is available."}`,
        response.status === 401,
      );
    const tokens = sharedTokenSchema.parse(await response.json());
    const next = { ...current, ...tokens };
    const latest = readCredentials();
    if (
      !latest ||
      typeof latest === "string" ||
      latest.refreshToken !== current.refreshToken
    )
      throw new Error("Credentials changed during refresh. Retry the command.");
    saveCredentials(next);
    return next;
  });
}
