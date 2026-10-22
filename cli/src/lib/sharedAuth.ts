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
function uncertainRefresh(): RefreshError {
  return new RefreshError(
    "Credential refresh outcome is uncertain. To avoid reusing a possibly consumed refresh token, run gauge auth login.",
    true,
  );
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
    if (current.refreshPending) throw uncertainRefresh();
    if (current.accessToken !== previous.accessToken) return current;
    if (!current.refreshToken) return current;
    if (!force && Date.parse(current.expiresAt ?? "") > Date.now() + 60_000)
      return current;
    // Persist before any network work, including when the process dies or the
    // response/new credentials cannot be saved. Retain the secret for logout.
    saveCredentials({ ...current, refreshPending: true });
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
    } catch {
      throw uncertainRefresh();
    }
    // Chat rejects throttled requests before attempting rotation. Server/proxy
    // errors cannot establish whether a rotation committed, so stay uncertain.
    if (response.status === 429) {
      saveCredentials(current);
      throw new RefreshError(
        "Credential refresh was rate limited. Retry later.",
      );
    }
    if (!response.ok)
      throw response.status === 401
        ? new RefreshError(
            "Credential refresh rejected. Run gauge auth login.",
            true,
          )
        : uncertainRefresh();
    try {
      const tokens = sharedTokenSchema.parse(await response.json());
      const next = { ...current, ...tokens };
      delete next.refreshPending;
      const latest = readCredentials();
      if (
        !latest ||
        typeof latest === "string" ||
        latest.refreshToken !== current.refreshToken
      )
        throw new Error(
          "Credentials changed during refresh. Retry the command.",
        );
      saveCredentials(next);
      return next;
    } catch {
      throw uncertainRefresh();
    }
  });
}
