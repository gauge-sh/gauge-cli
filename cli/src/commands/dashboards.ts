import { readFileSync } from "node:fs";
import type { dashboards } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

function dashboardsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/dashboards`;
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("dashboards"))
    .description("Saved dashboards (CRUD + view filters; layout is UI-only)");

  group
    .command("list")
    .description("List your dashboard library")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const res = await createClient().get<dashboards.ListDashboardsResponse>(
        dashboardsPath(org),
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else
        printItems(
          res.items.map((d) => ({
            key: d.key,
            name: d.name,
            source: d.source,
            default: d.isUserDefault ? "you" : d.isOrgDefault ? "org" : "",
          })),
          "table",
        );
    });

  group
    .command("get <key>")
    .description("Show one resolved dashboard (widgets + saved filters)")
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const dashboard = await createClient().get<dashboards.ResolvedDashboard>(
        `${dashboardsPath(org)}/${encodeURIComponent(key)}`,
      );
      if (resolveOutput(cmd) === "json") {
        printJson(dashboard);
        return;
      }
      console.log(`key:     ${dashboard.key}`);
      console.log(`name:    ${dashboard.name}`);
      console.log(`filters: ${JSON.stringify(dashboard.defaultFilters)}`);
      console.log("widgets:");
      for (const w of dashboard.widgets)
        console.log(`  [${w.id}] ${w.title} (${w.viz})`);
    });

  group
    .command("create <name>")
    .description("Create an empty personal dashboard")
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const created = await createClient().post<dashboards.ResolvedDashboard>(
        dashboardsPath(org),
        { name },
      );
      if (resolveOutput(cmd) === "json") printJson(created);
      else console.log(`Created dashboard ${created.key}`);
    });

  group
    .command("rename <key> <name>")
    .description("Rename a dashboard (in your overlay)")
    .action(async (key: string, name: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const updated = await createClient().patch<dashboards.ResolvedDashboard>(
        `${dashboardsPath(org)}/${encodeURIComponent(key)}`,
        { name },
      );
      if (resolveOutput(cmd) === "json") printJson(updated);
      else console.log(`Renamed to ${updated.name}`);
    });

  group
    .command("rm <key>")
    .description("Delete a dashboard (built-in templates refuse)")
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      await createClient().delete<void>(
        `${dashboardsPath(org)}/${encodeURIComponent(key)}`,
      );
      if (resolveOutput(cmd) !== "json")
        console.log(`Deleted dashboard ${key}`);
    });

  group
    .command("filters <key>")
    .description("Replace a dashboard's saved view-level filters")
    .option("--json <json>", "the filters object inline")
    .option("--file <path>", 'the filters object from a file ("-" for stdin)')
    .option("--clear", "remove all saved filters")
    .action(
      async (
        key: string,
        opts: { json?: string; file?: string; clear?: boolean },
        cmd: Command,
      ) => {
        const org = await resolveOrg(cmd);
        const provided = [opts.json, opts.file, opts.clear].filter(
          (v) => v !== undefined && v !== false,
        ).length;
        if (provided !== 1)
          throw new CliError(
            "usage",
            "pass exactly one of --json, --file, or --clear",
          );
        let filters: unknown = {};
        if (!opts.clear) {
          const raw =
            opts.json ??
            readFileSync(opts.file === "-" ? 0 : (opts.file as string), "utf8");
          try {
            filters = JSON.parse(raw);
          } catch (e) {
            throw new CliError(
              "usage",
              `filters are not valid JSON: ${e instanceof Error ? e.message : e}`,
            );
          }
        }
        const updated = await createClient().put<dashboards.ResolvedDashboard>(
          `${dashboardsPath(org)}/${encodeURIComponent(key)}/filters`,
          filters,
        );
        if (resolveOutput(cmd) === "json") printJson(updated);
        else
          console.log(
            `Saved filters: ${JSON.stringify(updated.defaultFilters)}`,
          );
      },
    );
}
