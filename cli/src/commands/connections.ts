import type { connections } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { confirmOrAbort } from "../lib/confirm";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";
import { registerReauthorize } from "./connectionsReauthorize";

type ConnectionSummary = connections.ConnectionSummary;

/** Environment variable a secret may be read from instead of stdin. */
export const CONNECTION_SECRET_ENV = "GAUGE_CONNECTION_SECRET";

const AUTH_STYLES = ["bearer", "header", "query"] as const;
type AuthStyle = (typeof AUTH_STYLES)[number];

function connectionsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/connections`;
}

function row(c: ConnectionSummary) {
  return {
    id: c.id,
    name: c.handle,
    vendor: c.profileLabel,
    placeholder: [c.credentialKey, c.basicPasswordKey]
      .filter(Boolean)
      .join(", "),
    domains: c.allowedHosts.join(", "),
    kind: c.kind,
    value: c.last4 ? `····${c.last4}` : "",
  };
}

/**
 * Read a secret from GAUGE_CONNECTION_SECRET or stdin, never from argv, where
 * it would land in shell history and process listings.
 */
async function readSecret(
  opts: { stdin?: boolean },
  what: "key" | "password",
): Promise<string> {
  if (!opts.stdin) {
    const env = process.env[CONNECTION_SECRET_ENV];
    if (env?.trim()) return what === "key" ? env.trim() : env;
  }
  if (process.stdin.isTTY) {
    process.stderr.write(`Paste the ${what}, press Enter, then Ctrl-D:\n`);
  }
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  // A password keeps its leading and inner whitespace; only the line ending a
  // pipe or a paste adds is dropped.
  const secret = what === "key" ? data.trim() : data.replace(/\r?\n$/, "");
  if (!secret.trim()) {
    throw new CliError(
      "usage",
      `No ${what} provided. Pipe it to stdin (e.g. \`gauge connections rotate <name> < secret.txt\`) or set ${CONNECTION_SECRET_ENV}.`,
    );
  }
  return secret;
}

async function readCredential(opts: {
  stdin?: boolean;
  username?: string;
}): Promise<connections.ConnectionCredentialInput> {
  if (opts.username === undefined) return readSecret(opts, "key");
  return {
    username: opts.username,
    password: await readSecret(opts, "password"),
  };
}

/** Resolve a name or id to a live connection through the list endpoint. */
export async function findConnection(
  org: string,
  ref: string,
): Promise<ConnectionSummary> {
  const res = await createClient().get<connections.ListConnectionsResponse>(
    connectionsPath(org),
  );
  const match =
    res.items.find((c) => c.id === ref) ??
    res.items.find((c) => c.handle === ref);
  if (!match) {
    throw new CliError(
      "not_found",
      `No connection named or with id "${ref}".`,
      {
        hint: "Run `gauge connections list --hosted` to see the org's connections.",
      },
    );
  }
  return match;
}

function printConnection(
  cmd: Command,
  c: ConnectionSummary,
  verb: string,
): void {
  if (resolveOutput(cmd) === "json") {
    printJson(c);
    return;
  }
  console.log(`${verb} ${c.handle}`);
  printItems([row(c)], "table");
}

type AddOptions = {
  handle: string;
  profile?: string;
  host?: string;
  auth?: string;
  headerName?: string;
  headerPrefix?: string;
  queryParam?: string;
  username?: string;
  stdin?: boolean;
};

/** Validate the --host flag combination before any secret is read or sent. */
function hostAuth(opts: AddOptions): connections.ConnectionHostAuth {
  const style = (opts.auth ?? "bearer") as AuthStyle;
  if (!AUTH_STYLES.includes(style)) {
    throw new CliError(
      "usage",
      `Unknown --auth "${opts.auth}" (expected ${AUTH_STYLES.join("|")}).`,
    );
  }
  if (style !== "header" && opts.headerName !== undefined)
    throw new CliError("usage", "--header-name requires --auth header.");
  if (style !== "header" && opts.headerPrefix !== undefined)
    throw new CliError("usage", "--header-prefix requires --auth header.");
  if (style !== "query" && opts.queryParam !== undefined)
    throw new CliError("usage", "--query-param requires --auth query.");
  if (style === "header") {
    if (!opts.headerName)
      throw new CliError("usage", "--auth header requires --header-name.");
    return {
      style,
      headerName: opts.headerName,
      ...(opts.headerPrefix !== undefined
        ? { valuePrefix: opts.headerPrefix }
        : {}),
    };
  }
  if (style === "query") {
    if (!opts.queryParam)
      throw new CliError("usage", "--auth query requires --query-param.");
    return { style, queryParam: opts.queryParam };
  }
  return { style };
}

/** Build the create request, validating flags before reading the secret. */
async function addRequest(
  opts: AddOptions,
): Promise<connections.CreateConnectionBody> {
  if (Boolean(opts.profile) === Boolean(opts.host)) {
    throw new CliError("usage", "Pass exactly one of --profile or --host.");
  }
  if (opts.profile) {
    if (
      opts.auth !== undefined ||
      opts.headerName !== undefined ||
      opts.headerPrefix !== undefined ||
      opts.queryParam !== undefined
    ) {
      throw new CliError(
        "usage",
        "--auth, --header-name, --header-prefix, and --query-param apply only to --host.",
      );
    }
    return {
      handle: opts.handle,
      profileSlug: opts.profile,
      credential: await readCredential(opts),
    };
  }
  if (opts.username !== undefined)
    throw new CliError("usage", "--username applies only to --profile.");
  const auth = hostAuth(opts);
  return {
    handle: opts.handle,
    host: opts.host as string,
    auth,
    credential: await readSecret(opts, "key"),
  };
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("connections")).description(
    "Manage the org's stored credentials (values are write-only)",
  );

  group
    .command("list")
    .description("List credentials with the ids --connection accepts")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const res = await createClient().get<connections.ListConnectionsResponse>(
        connectionsPath(org),
      );
      if (resolveOutput(cmd) === "json") {
        printJson(res.items);
        return;
      }
      printItems(res.items.map(row), "table");
    });

  group
    .command("add")
    .description(
      `Store a credential for a built-in profile or a custom host; reads the value from stdin or ${CONNECTION_SECRET_ENV}`,
    )
    .requiredOption("--handle <name>", "name for the connection")
    .option("--profile <slug>", "built-in vendor profile (e.g. github)")
    .option(
      "--host <host>",
      "custom vendor host (e.g. api.example.com); the credential is sent only to it",
    )
    .option(
      "--auth <style>",
      `how the host receives the credential: ${AUTH_STYLES.join("|")} (default bearer)`,
    )
    .option("--header-name <name>", "header to send (with --auth header)")
    .option(
      "--header-prefix <prefix>",
      'text before the value in the header, e.g. "Token " (with --auth header)',
    )
    .option("--query-param <name>", "query parameter (with --auth query)")
    .option(
      "--username <user>",
      "username for a profile that uses HTTP Basic; the password is read like a key",
    )
    .option(
      "--stdin",
      `read the value from stdin (ignores ${CONNECTION_SECRET_ENV})`,
    )
    .action(async (opts: AddOptions, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const body = await addRequest(opts);
      const res = await createClient().post<ConnectionSummary>(
        connectionsPath(org),
        body,
      );
      printConnection(cmd, res, "Added");
    });

  group
    .command("rotate <connection>")
    .description(
      `Replace a connection's stored value (name or id); reads it from stdin or ${CONNECTION_SECRET_ENV}`,
    )
    .option(
      "--username <user>",
      "username for a connection that uses HTTP Basic; the password is read like a key",
    )
    .option(
      "--stdin",
      `read the value from stdin (ignores ${CONNECTION_SECRET_ENV})`,
    )
    .action(
      async (
        ref: string,
        opts: { username?: string; stdin?: boolean },
        cmd: Command,
      ) => {
        const org = await resolveOrg(cmd);
        const current = await findConnection(org, ref);
        if (current.basicPasswordKey && opts.username === undefined) {
          throw new CliError(
            "usage",
            `"${current.handle}" uses a username and password. Pass --username and provide the password on stdin or in ${CONNECTION_SECRET_ENV}.`,
          );
        }
        if (!current.basicPasswordKey && opts.username !== undefined) {
          throw new CliError(
            "usage",
            `"${current.handle}" takes a single value; --username does not apply.`,
          );
        }
        const body: connections.RotateConnectionCredentialBody = {
          credential: await readCredential(opts),
        };
        const res = await createClient().put<ConnectionSummary>(
          `${connectionsPath(org)}/${encodeURIComponent(current.id)}/credential`,
          body,
        );
        printConnection(cmd, res, "Rotated");
      },
    );

  group
    .command("delete <connection>")
    .description("Delete a connection (name or id)")
    .option(
      "-y, --yes",
      "skip the confirmation prompt (required when not on a TTY)",
    )
    .action(async (ref: string, opts: { yes?: boolean }, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const current = await findConnection(org, ref);
      await confirmOrAbort(
        `Delete connection "${current.handle}" (${current.id})? Evals and prompts that attach it will stop using it.`,
        opts.yes,
      );
      const res =
        await createClient().delete<connections.DeleteConnectionResponse>(
          `${connectionsPath(org)}/${encodeURIComponent(current.id)}`,
        );
      if (resolveOutput(cmd) === "json")
        printJson({ ...res, handle: current.handle });
      else console.log(`Deleted ${current.handle}`);
    });

  registerReauthorize(group);
}
