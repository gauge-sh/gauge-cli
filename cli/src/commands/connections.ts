import type { connections } from "@withgauge/api-schemas";
import { type Command, Option } from "commander";
import { CliError, createClient } from "../lib/client";
import { confirmOrAbort } from "../lib/confirm";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";
import { readHiddenLine } from "../lib/secretPrompt";
import { registerReauthorize } from "./connectionsReauthorize";

type ConnectionSummary = connections.ConnectionSummary;

/** Environment variable a secret may be read from instead of stdin. */
export const CONNECTION_SECRET_ENV = "GAUGE_CONNECTION_SECRET";

const AUTH_STYLES = ["bearer", "header", "query", "basic"] as const;
type AuthStyle = (typeof AUTH_STYLES)[number];

function connectionsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/connections`;
}

function row(c: ConnectionSummary) {
  return {
    id: c.id,
    name: c.handle,
    hosts: c.allowedHosts.join(", "),
    env: [c.credentialKey, c.basicPasswordKey].filter(Boolean).join(", "),
    kind: c.kind,
    key: c.last4 ? `····${c.last4}` : "",
  };
}

/**
 * Read a secret from GAUGE_CONNECTION_SECRET, a hidden terminal prompt, or
 * piped stdin — never from argv, where it would land in shell history and
 * process listings. The value is never echoed, printed, or logged.
 */
async function readSecret(
  opts: { stdin?: boolean },
  what: "key" | "password",
  name: string,
): Promise<string> {
  if (!opts.stdin) {
    const env = process.env[CONNECTION_SECRET_ENV];
    if (env?.trim()) return what === "key" ? env.trim() : env;
  }
  let data: string;
  if (process.stdin.isTTY) {
    data = await readHiddenLine(
      `${what === "key" ? "Key" : "Password"} for ${name} (hidden, press Enter): `,
    );
  } else {
    process.stdin.setEncoding("utf8");
    data = "";
    for await (const chunk of process.stdin) data += chunk;
  }
  // A password keeps its leading and inner whitespace; only the line ending a
  // pipe or a paste adds is dropped.
  const secret = what === "key" ? data.trim() : data.replace(/\r?\n$/, "");
  if (!secret.trim()) {
    throw new CliError(
      "usage",
      `No ${what} provided. Enter it at the prompt, pipe it to stdin (e.g. \`gauge connections rotate <name> < secret.txt\`), or set ${CONNECTION_SECRET_ENV}.`,
    );
  }
  return secret;
}

async function readCredential(
  opts: { stdin?: boolean; username?: string },
  name: string,
): Promise<connections.ConnectionCredentialInput> {
  if (opts.username === undefined) return readSecret(opts, "key", name);
  return {
    username: opts.username,
    password: await readSecret(opts, "password", name),
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
  handle?: string;
  profile?: string;
  host?: string[];
  env?: string;
  auth?: string;
  headerName?: string;
  headerPrefix?: string;
  queryParam?: string;
  username?: string;
  stdin?: boolean;
};

const ENV_VAR = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Validate the presentation flags; undefined means "let Gauge decide". */
function hostAuth(opts: AddOptions): connections.ConnectionHostAuth | undefined {
  if (opts.auth === undefined) {
    if (opts.headerName !== undefined || opts.headerPrefix !== undefined)
      throw new CliError("usage", "--header-name requires --auth header.");
    if (opts.queryParam !== undefined)
      throw new CliError("usage", "--query-param requires --auth query.");
    return undefined;
  }
  const style = opts.auth as AuthStyle;
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

/** The connection's name: the argument, or the deprecated --handle. */
function connectionName(arg: string | undefined, opts: AddOptions): string {
  if (arg !== undefined && opts.handle !== undefined && arg !== opts.handle) {
    throw new CliError(
      "usage",
      `Name the connection once: "${arg}" or --handle "${opts.handle}".`,
    );
  }
  const name = arg ?? opts.handle;
  if (!name) {
    throw new CliError(
      "usage",
      "Name the connection: gauge connections add <name> --host <host>.",
    );
  }
  return name;
}

type HostRequest = Omit<connections.PreviewConnectionBody, "paired">;

/** Validate every flag before anything is sent or any secret is read. */
function hostRequest(name: string, opts: AddOptions): HostRequest {
  const [host, ...additionalHosts] = opts.host ?? [];
  if (!host) {
    throw new CliError(
      "usage",
      "Pass --host with the exact host the key may be sent to (repeat it for more hosts).",
    );
  }
  if (opts.env !== undefined && !ENV_VAR.test(opts.env)) {
    throw new CliError(
      "usage",
      `--env "${opts.env}" is not an environment variable name: use uppercase letters, digits, and underscores, starting with a letter (at most 64 characters).`,
    );
  }
  const auth = hostAuth(opts);
  if (opts.username !== undefined && auth && auth.style !== "basic") {
    throw new CliError(
      "usage",
      "--username sends a username and password with HTTP Basic; it cannot be combined with --auth " +
        `${auth.style}.`,
    );
  }
  if (auth?.style === "basic" && opts.username === undefined) {
    throw new CliError("usage", "--auth basic requires --username.");
  }
  return {
    handle: name,
    host,
    ...(additionalHosts.length ? { additionalHosts } : {}),
    ...(auth ? { auth } : {}),
    ...(opts.env !== undefined ? { credentialKey: opts.env } : {}),
  };
}

/**
 * Ask Gauge what this connection would be — its hosts and the environment
 * variable agents see — so the user sees both before entering the key, and a
 * bad host or a taken name fails before anything is pasted. Undefined when the
 * server predates the preview.
 */
async function previewConnection(
  org: string,
  request: HostRequest,
  paired: boolean,
): Promise<connections.ConnectionPreview | undefined> {
  try {
    return await createClient().post<connections.ConnectionPreview>(
      `${connectionsPath(org)}/preview`,
      { ...request, ...(paired ? { paired } : {}) },
    );
  } catch (error) {
    if (
      error instanceof CliError &&
      (error.code === "not_found" || /HTTP 405\b/.test(error.message))
    ) {
      return undefined;
    }
    throw error;
  }
}

function describePreview(preview: connections.ConnectionPreview): string {
  const env = preview.basicPasswordKey
    ? `${preview.credentialKey} (username) and ${preview.basicPasswordKey} (password)`
    : preview.credentialKey;
  return [
    `Adding "${preview.handle}"${preview.builtIn ? ` (${preview.builtIn})` : ""}.`,
    `  Sent only to: ${preview.allowedHosts.join(", ")}`,
    `  Agents see:   ${env}${preview.builtIn ? "" : "  (set --env to change)"}`,
  ].join("\n");
}

/** The deprecated `--profile <slug>` form, kept for one release. */
async function legacyProfileRequest(
  name: string,
  opts: AddOptions,
): Promise<connections.CreateConnectionBody> {
  if (
    opts.host !== undefined ||
    opts.env !== undefined ||
    opts.auth !== undefined ||
    opts.headerName !== undefined ||
    opts.headerPrefix !== undefined ||
    opts.queryParam !== undefined
  ) {
    throw new CliError(
      "usage",
      "--profile is deprecated and cannot be combined with --host or its options; pass only --host.",
    );
  }
  process.stderr.write(
    "warning: --profile is deprecated and will be removed; pass the vendor's host instead (e.g. --host api.github.com).\n",
  );
  return {
    handle: name,
    profileSlug: opts.profile as string,
    credential: await readCredential(opts, name),
  };
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("connections")).description(
    "Manage the org's connections: stored keys and the exact hosts they may be sent to (values are write-only)",
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
    .command("add [name]")
    .description(
      `Store a key for one or more exact hosts; reads it from a hidden prompt, stdin, or ${CONNECTION_SECRET_ENV}`,
    )
    .option(
      "--host <host>",
      "exact host the key may be sent to (e.g. api.example.com); repeat for more hosts",
      (value: string, previous: string[] | undefined) => [
        ...(previous ?? []),
        value,
      ],
    )
    .option(
      "--env <VAR>",
      "environment variable agents see (default: derived from the host and shown before the key is read)",
    )
    .option(
      "--auth <style>",
      `how the host receives the key: ${AUTH_STYLES.join("|")} (default bearer; known vendors such as GitHub are recognized from the host)`,
    )
    .option("--header-name <name>", "header to send (with --auth header)")
    .option(
      "--header-prefix <prefix>",
      'text before the value in the header, e.g. "Token " (with --auth header)',
    )
    .option("--query-param <name>", "query parameter (with --auth query)")
    .option(
      "--username <user>",
      "send a username and password with HTTP Basic; the password is read like a key",
    )
    .option(
      "--stdin",
      `read the value from stdin (ignores ${CONNECTION_SECRET_ENV})`,
    )
    .addOption(new Option("--handle <name>").hideHelp())
    .addOption(new Option("--profile <slug>").hideHelp())
    .action(
      async (arg: string | undefined, opts: AddOptions, cmd: Command) => {
        const name = connectionName(arg, opts);
        const org = await resolveOrg(cmd);
        let body: connections.CreateConnectionBody;
        if (opts.profile !== undefined) {
          body = await legacyProfileRequest(name, opts);
        } else {
          const request = hostRequest(name, opts);
          const paired = opts.username !== undefined;
          const preview = await previewConnection(org, request, paired);
          if (preview && resolveOutput(cmd) !== "json") {
            process.stderr.write(`${describePreview(preview)}\n`);
          }
          body = { ...request, credential: await readCredential(opts, name) };
        }
        const res = await createClient().post<ConnectionSummary>(
          connectionsPath(org),
          body,
        );
        printConnection(cmd, res, "Added");
      },
    );

  group
    .command("rotate <connection>")
    .description(
      `Replace a connection's stored value (name or id); reads it from a hidden prompt, stdin, or ${CONNECTION_SECRET_ENV}`,
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
            `"${current.handle}" uses a username and password. Pass --username; the password is read at a hidden prompt, from stdin, or from ${CONNECTION_SECRET_ENV}.`,
          );
        }
        if (!current.basicPasswordKey && opts.username !== undefined) {
          throw new CliError(
            "usage",
            `"${current.handle}" takes a single value; --username does not apply.`,
          );
        }
        const body: connections.RotateConnectionCredentialBody = {
          credential: await readCredential(opts, current.handle),
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
