import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { mcp } from "@withgauge/api-schemas";
import { type ApiClient, CliError } from "./client";

type Dependencies = {
  openBrowser: (url: string) => void;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
  report: (message: string) => void;
};

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* The URL is also printed for headless terminals. */
  }
}

type ConnectedStatus = Extract<mcp.McpOauthStatus, { status: "connected" }>;

/** How a caller names its own retry and client-registration options. */
type ConsentHints = {
  needsClientId: (redirectUri: string) => string;
  timedOut: string;
};

const MCP_ADD_HINTS: ConsentHints = {
  needsClientId: (redirectUri) =>
    `Register an OAuth client with redirect URI ${redirectUri}, then retry with --oauth-client-id. If required, supply its secret using --oauth-client-secret-env.`,
  timedOut:
    "If consent succeeded, use `gauge connections list --hosted` and retry with --connection <id>. Otherwise retry with --oauth; incomplete saved grants can resume without new consent.",
};

function mcpAuthorizationsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/mcp-authorizations`;
}

/** The server issued a key it cannot renew, so the connection has an end. */
export function nonRefreshableWarning(expiresAt: string | null): string {
  const when = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const lead = Number.isFinite(when)
    ? `Note: this server issued a key with no refresh token. It expires at ${new Date(when).toISOString()}, and runs are refused when it is about to expire.`
    : "Note: this server issued a key with no refresh token and did not say when it expires. Runs will fail to authenticate once it lapses.";
  return `${lead} Authorize again to renew it.`;
}

/** Human consent stays in the browser; only a non-secret connection ID returns
 * to the caller. Progress goes to stderr so JSON output remains parseable. */
export async function connectMcpOauth(
  client: Pick<ApiClient, "post" | "get">,
  org: string,
  input: mcp.BeginMcpOauthBody,
  options: { browser: boolean; timeoutSeconds: number },
  overrides: Partial<Dependencies> = {},
): Promise<string> {
  const begun = await client.post<mcp.BeginMcpOauthResponse>(
    mcpAuthorizationsPath(org),
    input,
  );
  const connected = await awaitMcpOauthConsent(
    client,
    org,
    begun,
    options,
    MCP_ADD_HINTS,
    overrides,
  );
  // `connections reauthorize` words its own note; this one is for `mcp add`.
  if (connected.nonRefreshable)
    (overrides.report ?? console.error)(
      nonRefreshableWarning(connected.nonRefreshable.expiresAt),
    );
  return connected.connectionId;
}

/**
 * Finish any consent that answered with the MCP OAuth begin shape: open the
 * browser, then poll `/mcp-authorizations/{id}` until the connection is ready.
 * A `connected` answer means an earlier consent already finished, so no
 * browser is needed.
 */
export async function awaitMcpOauthConsent(
  client: Pick<ApiClient, "get">,
  org: string,
  result: mcp.BeginMcpOauthResponse,
  options: { browser: boolean; timeoutSeconds: number },
  hints: ConsentHints,
  overrides: Partial<Dependencies> = {},
): Promise<ConnectedStatus> {
  const deps: Dependencies = {
    openBrowser,
    sleep,
    now: Date.now,
    report: console.error,
    ...overrides,
  };
  const path = mcpAuthorizationsPath(org);
  if (result.kind === "connected")
    return { status: "connected", connectionId: result.connectionId };
  if (result.kind === "problem")
    throw new CliError("invalid_request", result.problem);
  if (result.kind === "needs-client-id") {
    throw new CliError("invalid_request", result.reason, {
      hint: hints.needsClientId(result.redirectUri),
    });
  }
  let url: URL;
  try {
    url = new URL(result.authorizationUrl);
  } catch {
    throw new CliError(
      "internal",
      "Gauge returned an invalid authorization URL.",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new CliError(
      "internal",
      "Gauge returned an unsafe authorization URL.",
    );
  const expiresAt = Date.parse(result.expiresAt);
  if (!Number.isFinite(expiresAt))
    throw new CliError(
      "internal",
      "Gauge returned an invalid authorization expiry.",
    );
  deps.report(
    `Authorize this MCP connection in your browser:\n${url}\nWaiting for consent…`,
  );
  if (options.browser) deps.openBrowser(url.toString());
  const deadline = Math.min(
    expiresAt,
    deps.now() + options.timeoutSeconds * 1000,
  );
  while (deps.now() < deadline) {
    // A stalled poll must not outlive the consent timeout.
    const signal = AbortSignal.timeout(Math.max(1, deadline - deps.now()));
    let status: mcp.McpOauthStatus;
    try {
      status = await client.get<mcp.McpOauthStatus>(
        `${path}/${encodeURIComponent(result.authorizationId)}`,
        undefined,
        signal,
      );
    } catch (error) {
      if (signal.aborted) break;
      throw error;
    }
    if (status.status === "connected") return status;
    if (status.status === "failed" || status.status === "expired")
      throw new CliError("invalid_request", status.message);
    await deps.sleep(Math.min(2000, Math.max(0, deadline - deps.now())));
  }
  throw new CliError(
    "invalid_request",
    "Timed out waiting for MCP authorization.",
    { hint: hints.timedOut },
  );
}
