import { readFileSync } from "node:fs";
import type { mcp } from "@withgauge/api-schemas";
import {
  parseMcpSpec,
  saveMcpServerBodySchema,
} from "@withgauge/api-schemas/mcp";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { collect } from "../lib/flags";
import { printItems, printJson } from "../lib/output";
import { LOCAL_MCP_HINT } from "../lib/localCapabilities";
import { connectMcpOauth } from "../lib/mcpOauth";

function mcpPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/mcp-servers`;
}

function serverPath(org: string, ref: string): string {
  return `${mcpPath(org)}/${encodeURIComponent(ref)}`;
}

function specLabel(spec: mcp.McpSpec): string {
  return spec.transport === "stdio"
    ? [spec.command, ...(spec.args ?? [])].join(" ")
    : (spec.url ?? "");
}

function specFromOpts(opts: {
  specFile?: string;
  command?: string;
  arg: string[];
  env: string[];
  url?: string;
  header: string[];
  serverName?: string;
  description?: string;
  tool: string[];
}): unknown {
  if (opts.specFile !== undefined) {
    if (opts.command !== undefined || opts.url !== undefined)
      throw new CliError("usage", "--spec-file conflicts with --command/--url");
    try {
      return JSON.parse(
        readFileSync(opts.specFile === "-" ? 0 : opts.specFile, "utf8"),
      );
    } catch (e) {
      throw new CliError(
        "usage",
        `could not read --spec-file: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  if ((opts.command !== undefined) === (opts.url !== undefined))
    throw new CliError(
      "usage",
      "pass exactly one of --command (stdio) or --url (http), or --spec-file",
    );
  const tools = opts.tool.map((line) => {
    const colon = line.indexOf(":");
    return colon > 0
      ? {
          name: line.slice(0, colon).trim(),
          description: line.slice(colon + 1).trim(),
        }
      : { name: line.trim() };
  });
  return {
    transport: opts.command !== undefined ? "stdio" : "http",
    ...(opts.command !== undefined
      ? { command: opts.command, args: opts.arg, envNames: opts.env }
      : { url: opts.url, headerNames: opts.header }),
    ...(opts.serverName ? { serverName: opts.serverName } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("mcp"), {
    hint: LOCAL_MCP_HINT,
  }).description("Manage MCP servers used by hosted eval and preference runs");

  group
    .command("list")
    .description("List the org's MCP servers with their newest version")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const res = await createClient().get<mcp.ListMcpServersResponse>(
        mcpPath(org),
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else
        printItems(
          res.items.map((s) => ({
            name: s.name,
            latest: s.latestVersion?.label ?? "",
            versions: s.versionCount,
            transport: s.latestVersion?.spec.transport ?? "",
            invocation: s.latestVersion ? specLabel(s.latestVersion.spec) : "",
            note: s.note ?? "",
          })),
          "table",
        );
    });

  group
    .command("get <ref>")
    .description("Show one MCP server: note and every version")
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const server = await createClient().get<mcp.McpServerDetail>(
        serverPath(org, ref),
      );
      if (resolveOutput(cmd) === "json") {
        printJson(server);
        return;
      }
      console.log(`name:  ${server.name}`);
      console.log(`id:    ${server.id}`);
      console.log(`note:  ${server.note ?? "(none)"}`);
      console.log("versions:");
      for (const v of server.versions) {
        console.log(
          `  ${server.name}@${v.label}  [${v.spec.transport}]  ${specLabel(v.spec)}  ${v.createdAt}`,
        );
        if (v.connectionId) console.log(`    connection: ${v.connectionId}`);
        for (const w of v.warnings) console.log(`    warning: ${w.message}`);
      }
    });

  group
    .command("add")
    .description(
      "Add a server, or append a version to an existing --name (versions are immutable)",
    )
    .requiredOption("--name <handle>", "the handle (the agent config key)")
    .option("--command <cmd>", "stdio launch command, e.g. npx")
    .option(
      "--arg <arg>",
      "stdio argument (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--env <NAME>",
      "required env-var NAME — never a value (repeatable)",
      collect,
      [] as string[],
    )
    .option("--url <url>", "http endpoint")
    .option(
      "--header <NAME>",
      "required header NAME — never a value (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--server-name <name>",
      "agent-visible server name (default: handle)",
    )
    .option("--description <text>", "agent-visible description")
    .option(
      "--tool <name[: description]>",
      "declared tool (repeatable)",
      collect,
      [] as string[],
    )
    .option("--spec-file <path>", 'whole spec as JSON ("-" for stdin)')
    .option(
      "--label <label>",
      "version label (a typed label always mints; omitted dedups by spec digest)",
    )
    .option("--note <text>", "note shown on the index")
    .option(
      "--connection <id>",
      "bind an existing connection to this HTTP MCP server",
    )
    .option(
      "--oauth",
      "authorize this HTTP MCP in a browser, then save its connection binding",
    )
    .option(
      "--oauth-client-id <id>",
      "pre-registered OAuth client id, when the server requires one",
    )
    .option(
      "--oauth-client-secret-env <NAME>",
      "environment variable holding an optional OAuth client secret",
    )
    .option("--no-browser", "print the OAuth URL without opening a browser")
    .option(
      "--oauth-timeout <seconds>",
      "maximum time to wait for OAuth consent (1-600)",
      "600",
    )
    .action(
      async (
        opts: {
          name: string;
          command?: string;
          arg: string[];
          env: string[];
          url?: string;
          header: string[];
          serverName?: string;
          description?: string;
          tool: string[];
          specFile?: string;
          label?: string;
          note?: string;
          connection?: string;
          oauth?: boolean;
          oauthClientId?: string;
          oauthClientSecretEnv?: string;
          browser: boolean;
          oauthTimeout: string;
        },
        cmd: Command,
      ) => {
        const org = await resolveOrg(cmd);
        if (opts.oauth && opts.connection)
          throw new CliError(
            "usage",
            "--oauth conflicts with --connection; choose new consent or an existing connection.",
          );
        if (
          !opts.oauth &&
          (opts.oauthClientId ||
            opts.oauthClientSecretEnv ||
            opts.browser === false ||
            opts.oauthTimeout !== "600")
        )
          throw new CliError("usage", "OAuth options require --oauth.");
        const timeoutSeconds = Number(opts.oauthTimeout);
        if (
          !Number.isInteger(timeoutSeconds) ||
          timeoutSeconds < 1 ||
          timeoutSeconds > 600
        )
          throw new CliError(
            "usage",
            "--oauth-timeout must be an integer from 1 to 600 seconds.",
          );
        let spec: mcp.McpSpec;
        let body: mcp.SaveMcpServerBody;
        try {
          const raw = specFromOpts(opts);
          spec = parseMcpSpec(
            raw && typeof raw === "object" && !Array.isArray(raw)
              ? { specVersion: 1, serverName: opts.name, ...raw }
              : raw,
          );
          body = saveMcpServerBodySchema.parse({
            name: opts.name,
            spec,
            label: opts.label,
            note: opts.note,
            connectionId: opts.connection,
          });
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError(
            "usage",
            error instanceof Error
              ? error.message
              : "Invalid MCP configuration.",
          );
        }
        if ((opts.oauth || opts.connection) && spec.transport !== "http")
          throw new CliError(
            "usage",
            "--oauth and --connection require an HTTP MCP server.",
          );
        const client = createClient();
        if (opts.oauth) {
          let clientSecret: string | undefined;
          if (opts.oauthClientSecretEnv) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.oauthClientSecretEnv))
              throw new CliError(
                "usage",
                "--oauth-client-secret-env must name an environment variable.",
              );
            clientSecret = process.env[opts.oauthClientSecretEnv];
            if (!clientSecret)
              throw new CliError(
                "usage",
                "The OAuth client secret environment variable is empty or unset.",
              );
            if (!opts.oauthClientId)
              throw new CliError(
                "usage",
                "--oauth-client-secret-env requires --oauth-client-id.",
              );
          }
          body.connectionId = await connectMcpOauth(
            client,
            org,
            {
              name: opts.name,
              url: spec.url!,
              clientId: opts.oauthClientId,
              clientSecret,
            },
            { browser: opts.browser, timeoutSeconds },
          );
        }
        let result: mcp.SaveMcpServerResponse;
        try {
          result = await client.post<mcp.SaveMcpServerResponse>(
            mcpPath(org),
            body,
          );
        } catch (error) {
          if (opts.oauth && body.connectionId)
            console.error(
              `OAuth connected, but saving the MCP version failed. Retry with --connection ${body.connectionId} instead of --oauth.`,
            );
          throw error;
        }
        if (body.connectionId && result.connectionId !== body.connectionId)
          throw new CliError(
            "internal",
            "The server did not confirm the MCP connection binding.",
            {
              hint: `Upgrade the Gauge API before retrying with --connection ${body.connectionId}.`,
            },
          );
        if (resolveOutput(cmd) === "json") {
          printJson(result);
          return;
        }
        console.log(
          result.unchanged
            ? `Already current: ${result.handle}@${result.label} carries this spec`
            : `Saved ${result.handle}@${result.label} — ${result.invocation}`,
        );
        for (const w of result.warnings) console.error(`warning: ${w.message}`);
        console.error(
          `Attach it to an eval: gauge eval edit <id> --mcp ${result.handle}@${result.label}`,
        );
      },
    );

  group
    .command("edit <ref>")
    .description(
      "Rename or note a server (append versions with `gauge mcp add --name <handle>`)",
    )
    .option("--rename <handle>", "new handle (name@label refs must be updated)")
    .option("--note <text>", "replace the note")
    .option("--clear-note", "remove the note")
    .action(
      async (
        ref: string,
        opts: { rename?: string; note?: string; clearNote?: boolean },
        cmd: Command,
      ) => {
        const org = await resolveOrg(cmd);
        if (opts.note !== undefined && opts.clearNote)
          throw new CliError("usage", "--note and --clear-note conflict");
        const body: Record<string, unknown> = {};
        if (opts.rename !== undefined) body.name = opts.rename;
        if (opts.clearNote) body.note = null;
        else if (opts.note !== undefined) body.note = opts.note;
        if (Object.keys(body).length === 0)
          throw new CliError("usage", "nothing to change");
        const updated = await createClient().patch<mcp.McpServerDetail>(
          serverPath(org, ref),
          body,
        );
        if (resolveOutput(cmd) === "json") printJson(updated);
        else console.log(`Updated MCP server ${updated.name}`);
      },
    );

  group
    .command("rm <ref>")
    .description(
      "Remove a server; the handle stays reserved and finished runs keep their snapshot",
    )
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const result = await createClient().delete<{
        referencedBatches: number;
        referencedRuns: number;
      }>(serverPath(org, ref));
      if (resolveOutput(cmd) === "json") printJson(result);
      else
        console.log(
          `Deleted MCP server ${ref} (${result.referencedRuns} finished run(s) referenced it)`,
        );
    });
}
