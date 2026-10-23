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

/** Human consent stays in the browser; only a non-secret connection ID returns
 * to the caller. Progress goes to stderr so JSON output remains parseable. */
export async function connectMcpOauth(
  client: Pick<ApiClient, "post" | "get">,
  org: string,
  input: mcp.BeginMcpOauthBody,
  options: { browser: boolean; timeoutSeconds: number },
  overrides: Partial<Dependencies> = {},
): Promise<string> {
  const deps: Dependencies = {
    openBrowser,
    sleep,
    now: Date.now,
    report: console.error,
    ...overrides,
  };
  const path = `/api/v1/orgs/${encodeURIComponent(org)}/mcp-authorizations`;
  const result = await client.post<mcp.BeginMcpOauthResponse>(path, input);
  if (result.kind === "connected") return result.connectionId;
  if (result.kind === "problem")
    throw new CliError("invalid_request", result.problem);
  if (result.kind === "needs-client-id") {
    throw new CliError("invalid_request", result.reason, {
      hint: `Register an OAuth client with redirect URI ${result.redirectUri}, then retry with --oauth-client-id. If required, supply its secret using --oauth-client-secret-env.`,
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
    if (status.status === "connected") return status.connectionId;
    if (status.status === "failed" || status.status === "expired")
      throw new CliError("invalid_request", status.message);
    await deps.sleep(Math.min(2000, Math.max(0, deadline - deps.now())));
  }
  throw new CliError(
    "invalid_request",
    "Timed out waiting for MCP authorization.",
    {
      hint: "If consent succeeded, use `gauge connections list --hosted` and retry with --connection <id>. Otherwise retry with --oauth; incomplete saved grants can resume without new consent.",
    },
  );
}
