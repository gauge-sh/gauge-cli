import { readFileSync } from "node:fs";
import type { mcp } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { collect } from "../lib/flags";
import { printItems, printJson } from "../lib/output";
import { LOCAL_MCP_HINT } from "../lib/localCapabilities";

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
  const group = hostedOnly(program.command("mcp"), { hint: LOCAL_MCP_HINT })
    .description("Manage MCP servers used by hosted eval and preference runs");

  group
    .command("list")
    .description("List the org's MCP servers with their newest version")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
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
      const org = resolveOrg(cmd);
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
        },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        const result = await createClient().post<mcp.SaveMcpServerResponse>(
          mcpPath(org),
          {
            name: opts.name,
            spec: specFromOpts(opts),
            label: opts.label,
            note: opts.note,
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
        const org = resolveOrg(cmd);
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
      const org = resolveOrg(cmd);
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
