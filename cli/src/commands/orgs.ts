import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateOrgResponse } from "@withgauge/api-schemas/orgs";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { readConfig, updateConfig } from "../lib/config";
import { hostedOnly, resolveOutput } from "../lib/context";
import { gaugeState } from "../lib/gaugeState";
import {
  createdOrganization,
  fetchDirectory,
  findOrganization,
  productsLabel,
} from "../lib/orgDirectory";
import { printItems, printJson } from "../lib/output";

export function register(program: Command): void {
  const orgs = hostedOnly(program.command("orgs"), {
    account: true,
  }).description("Organizations, and which Gauge products each one uses");
  orgs
    .command("list", { isDefault: true })
    .description("List your Gauge organizations (* marks the saved default)")
    .action(async (_opts: unknown, command: Command) => {
      const rows = await fetchDirectory();
      const { orgId } = readConfig();
      if (resolveOutput(command) === "json") {
        printJson(rows.map((row) => ({ ...row, isDefault: row.id === orgId })));
        return;
      }
      printItems(
        rows.map((row) => ({
          default: row.id === orgId ? "*" : "",
          slug: row.slug,
          name: row.name,
          products: productsLabel(row.products),
        })),
        "table",
      );
    });

  orgs
    .command("create <name>")
    .description(
      "Create a Gauge Agents workspace and set its organization as the default",
    )
    .option("--website <url>", "company site (used as the logo source)")
    .option("--no-use", "don't set the new org as the default")
    .action(
      async (
        name: string,
        opts: { website?: string; use?: boolean },
        command: Command,
      ) => {
        // Verify directory access before creating anything with a legacy credential.
        await fetchDirectory();
        const created = await createClient().post<CreateOrgResponse>(
          "/api/v1/orgs",
          { name, website: opts.website },
        );
        const org = await createdOrganization(created.slug);
        if (opts.use !== false)
          updateConfig({ orgId: org.id, defaultOrg: undefined });
        if (resolveOutput(command) === "json") return printJson(org);
        console.log(`Created workspace ${org.name} (${org.slug})`);
        if (opts.use !== false) console.log(`Default org set to ${org.slug}`);
      },
    );

  orgs
    .command("use <org>")
    .description("Select a Gauge organization by its public slug")
    .option("--project", "save the selection in this project's gauge.json")
    .action(
      async (value: string, opts: { project?: boolean }, command: Command) => {
        const org = await findOrganization(value);
        if (opts.project) {
          const state = gaugeState(command);
          if (!state.root || !state.config)
            throw new CliError(
              "usage",
              "No valid gauge.json found. Run `gauge init` first.",
            );
          const { org: _legacyOrg, ...config } = state.config;
          writeFileSync(
            join(state.root, "gauge.json"),
            `${JSON.stringify({ ...config, orgId: org.id }, null, 2)}\n`,
          );
        } else updateConfig({ orgId: org.id, defaultOrg: undefined });
        if (resolveOutput(command) === "json")
          return printJson({ orgId: org.id, slug: org.slug, name: org.name });
        console.log(
          `${opts.project ? "Project" : "Default"} org set to ${org.name} (${org.slug})`,
        );
      },
    );
}
