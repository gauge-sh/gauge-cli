import type { mcp } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { resolveOrg, resolveOutput } from "../lib/context";
import { awaitMcpOauthConsent } from "../lib/mcpOauth";
import { printJson } from "../lib/output";
import { findConnection } from "./connections";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function connectionsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/connections`;
}

/**
 * `gauge connections reauthorize <handle-or-id>`: sign in again to renew an
 * OAuth connection IN PLACE. The connection keeps its id and handle, so MCP
 * server versions and evals bound to it keep working; deleting it and adding a
 * new one would not.
 */
export function registerReauthorize(group: Command): void {
  group
    .command("reauthorize")
    .description(
      "Sign in again to renew an OAuth connection in place (same id and handle)",
    )
    .argument("<connection>", "connection handle or id")
    .option(
      "--url <https-url>",
      "MCP server to authorize against (defaults to the one Gauge recorded)",
    )
    .option(
      "--client-id <id>",
      "pre-registered OAuth client id, when the server requires one",
    )
    .option(
      "--client-secret-env <NAME>",
      "environment variable holding an optional OAuth client secret",
    )
    .option("--no-browser", "print the OAuth URL without opening a browser")
    .option(
      "--timeout <seconds>",
      "maximum time to wait for consent (1-600)",
      "600",
    )
    .action(
      async (
        ref: string,
        opts: {
          url?: string;
          clientId?: string;
          clientSecretEnv?: string;
          browser: boolean;
          timeout: string;
        },
        cmd: Command,
      ) => {
        const timeoutSeconds = Number(opts.timeout);
        if (
          !Number.isInteger(timeoutSeconds) ||
          timeoutSeconds < 1 ||
          timeoutSeconds > 600
        )
          throw new CliError(
            "usage",
            "--timeout must be an integer from 1 to 600 seconds.",
          );
        let clientSecret: string | undefined;
        if (opts.clientSecretEnv) {
          if (!ENV_NAME.test(opts.clientSecretEnv))
            throw new CliError(
              "usage",
              "--client-secret-env must name an environment variable.",
            );
          if (!opts.clientId)
            throw new CliError(
              "usage",
              "--client-secret-env requires --client-id.",
            );
          clientSecret = process.env[opts.clientSecretEnv];
          if (!clientSecret)
            throw new CliError(
              "usage",
              "The OAuth client secret environment variable is empty or unset.",
            );
        }
        const org = await resolveOrg(cmd);
        const client = createClient();
        const connection = await findConnection(org, ref);
        const body: mcp.ReauthorizeConnectionBody = {
          ...(opts.url ? { url: opts.url } : {}),
          ...(opts.clientId ? { clientId: opts.clientId } : {}),
          ...(clientSecret ? { clientSecret } : {}),
        };
        const begun = await client.post<mcp.BeginMcpOauthResponse>(
          `${connectionsPath(org)}/${encodeURIComponent(connection.id)}/reauthorize`,
          body,
        );
        const retry = `gauge connections reauthorize ${connection.handle} --hosted`;
        const connected = await awaitMcpOauthConsent(
          client,
          org,
          begun,
          { browser: opts.browser, timeoutSeconds },
          {
            needsClientId: (redirectUri) =>
              `Register an OAuth client with redirect URI ${redirectUri}, then retry with --client-id. If required, supply its secret using --client-secret-env.`,
            timedOut: `If you finished signing in, run \`${retry}\` again: a completed sign-in resumes without new consent.`,
          },
        );
        const result = {
          connectionId: connected.connectionId,
          handle: connection.handle,
          ...(connected.nonRefreshable
            ? { nonRefreshable: connected.nonRefreshable }
            : {}),
        };
        if (resolveOutput(cmd) === "json") {
          printJson(result);
          return;
        }
        console.log(
          `Reauthorized ${connection.handle} (${connected.connectionId}). Its id is unchanged, so MCP servers using it keep working.`,
        );
        if (connected.nonRefreshable)
          console.error(
            connected.nonRefreshable.expiresAt
              ? `This server issued a key with no refresh token. It expires at ${connected.nonRefreshable.expiresAt}; run \`${retry}\` again before then.`
              : `This server issued a key with no refresh token and did not say when it expires. If sessions start failing to authenticate, run \`${retry}\` again.`,
          );
      },
    );
}
