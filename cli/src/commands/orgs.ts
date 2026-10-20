import type { MeOrg, MeResponse } from "@withgauge/api-schemas/me";
import type { CreateOrgResponse, OrgSettings } from "@withgauge/api-schemas/orgs";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { readConfig, updateConfig } from "../lib/config";
import { hostedOnly, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

function isDefault(org: MeOrg, defaultOrg: string | undefined): boolean {
  return (
    defaultOrg !== undefined &&
    (org.slug === defaultOrg || org.publicId === defaultOrg)
  );
}

export function register(program: Command): void {
  const orgs = hostedOnly(program.command("orgs"), { account: true })
    .description("Organizations");

  orgs
    .command("list")
    .description("List orgs you belong to")
    .action(async (_opts: unknown, command: Command) => {
      const output = resolveOutput(command);
      const me = await createClient().get<MeResponse>("/api/v1/me");
      const { defaultOrg } = readConfig();
      if (output === "json") {
        printJson(
          me.orgs.map((org) => ({
            ...org,
            isDefault: isDefault(org, defaultOrg),
          })),
        );
        return;
      }
      printItems(
        me.orgs.map((org) => ({
          slug: org.slug,
          name: org.name,
          publicId: org.publicId ?? "",
          default: isDefault(org, defaultOrg) ? "*" : "",
        })),
        "table",
      );
    });

  orgs
    .command("create <name>")
    .description("Create a new LOCAL workspace and set it as the default org")
    .option("--website <url>", "company site (used as the logo source)")
    .option("--no-use", "don't set the new org as the default")
    .action(
      async (
        name: string,
        opts: { website?: string; use?: boolean },
        command: Command,
      ) => {
        const created = await createClient().post<CreateOrgResponse>(
          "/api/v1/orgs",
          { name, website: opts.website },
        );
        if (opts.use !== false) updateConfig({ defaultOrg: created.slug });
        if (resolveOutput(command) === "json") {
          printJson(created);
          return;
        }
        console.log(`Created workspace ${created.name} (${created.slug})`);
        if (opts.use !== false) {
          console.log(`Default org set to ${created.slug}`);
        }
      },
    );

  orgs
    .command("use <org>")
    .description("Set the default org (slug or public id) in local config")
    .action(async (org: string, _opts: unknown, command: Command) => {
      const resolved = await createClient()
        .get<OrgSettings>(`/api/v1/orgs/${encodeURIComponent(org)}`)
        .catch((e: unknown) => {
          if (e instanceof CliError && e.code === "not_found")
            throw new CliError(
              "not_found",
              `Organization "${org}" was not found. Run \`gauge orgs list\`.`,
            );
          throw e;
        });
      updateConfig({ defaultOrg: resolved.slug });
      if (resolveOutput(command) === "json") {
        printJson({ defaultOrg: resolved.slug });
        return;
      }
      console.log(`Default org set to ${resolved.slug} (${resolved.name})`);
    });
}
