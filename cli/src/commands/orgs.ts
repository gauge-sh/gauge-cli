import type {
  CreateOrgResponse,
  OrgSettings,
} from "@withgauge/api-schemas/orgs";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { readConfig, updateConfig } from "../lib/config";
import { hostedOnly, resolveOutput } from "../lib/context";
import {
  type AgentsOrg,
  credentialKind,
  type DirectoryOrg,
  fetchAgentsOrgs,
  fetchDirectory,
  type Products,
  productsLabel,
  resolveOrgValue,
} from "../lib/orgDirectory";
import { printItems, printJson } from "../lib/output";

type OrgRow = {
  id: string | null;
  slug: string;
  name: string;
  products: Products;
  agentsSlug: string | null;
};

async function listOrgs(): Promise<OrgRow[]> {
  const kind = credentialKind();
  const [directory, agentsOrgs] = await Promise.all([
    kind === "legacy" ? Promise.resolve<DirectoryOrg[]>([]) : fetchDirectory(),
    kind === "api_key"
      ? Promise.resolve<AgentsOrg[]>([])
      : fetchAgentsOrgs().catch((error: unknown) => {
          // Legacy tokens have no Chat directory to fall back to.
          if (kind === "legacy") throw error;
          return null;
        }),
  ]);
  const workspaces = new Map(
    (agentsOrgs ?? [])
      .filter((o) => o.canonicalGaugeOrganizationId)
      .map((o) => [o.canonicalGaugeOrganizationId as string, o]),
  );
  const rows: OrgRow[] = directory.map((org) => {
    const workspace = workspaces.get(org.id);
    const agents =
      org.products?.agents ?? (agentsOrgs ? workspace !== undefined : null);
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      products: { chat: org.products?.chat ?? true, agents },
      agentsSlug: workspace?.slug ?? null,
    };
  });
  const listed = new Set(directory.map((org) => org.id));
  for (const workspace of agentsOrgs ?? []) {
    const id = workspace.canonicalGaugeOrganizationId ?? null;
    if (id && listed.has(id)) continue;
    rows.push({
      id,
      slug: workspace.slug,
      name: workspace.name,
      products: { chat: false, agents: true },
      agentsSlug: workspace.slug,
    });
  }
  return rows;
}

function isDefault(row: OrgRow, defaultOrg: string | undefined): boolean {
  return (
    defaultOrg !== undefined &&
    [row.id, row.slug, row.agentsSlug].includes(defaultOrg)
  );
}

export function register(program: Command): void {
  const orgs = hostedOnly(program.command("orgs"), {
    account: true,
  }).description("Organizations, and which Gauge products each one uses");

  orgs
    .command("list", { isDefault: true })
    .description("List organizations you belong to (* marks defaultOrg)")
    .action(async (_opts: unknown, command: Command) => {
      const rows = await listOrgs();
      const { defaultOrg } = readConfig();
      if (resolveOutput(command) === "json") {
        printJson(
          rows.map((row) => ({
            ...row,
            isDefault: isDefault(row, defaultOrg),
          })),
        );
        return;
      }
      printItems(
        rows.map((row) => ({
          default: isDefault(row, defaultOrg) ? "*" : "",
          id: row.id ?? "",
          slug: row.slug,
          name: row.name,
          products: productsLabel(row.products),
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
    .description(
      "Set the default org for Gauge Chat and Gauge Agents (slug or id)",
    )
    .action(async (org: string, _opts: unknown, command: Command) => {
      const resolved = await resolveOrgValue(org);
      let id = resolved.id;
      let name = resolved.name;
      if (resolved.via === "uuid" || resolved.via === "unresolved") {
        const match = (await listOrgs()).find((row) =>
          [row.id, row.slug, row.agentsSlug].includes(org),
        );
        if (match) {
          id = match.id ?? id;
          name = match.name;
        }
        else {
          // Staff can address organizations they don't belong to.
          const found = await createClient()
            .get<OrgSettings>(`/api/v1/orgs/${encodeURIComponent(org)}`)
            .catch((e: unknown) => {
              if (e instanceof CliError && e.code === "not_found")
                throw new CliError(
                  "not_found",
                  `Organization "${org}" was not found. Run \`gauge orgs list\`.`,
                );
              throw e;
            });
          if (resolved.via === "unresolved") id = found.slug;
          name = found.name;
        }
      }
      updateConfig({ defaultOrg: id });
      if (resolveOutput(command) === "json") {
        printJson({ defaultOrg: id, name: name ?? null });
        return;
      }
      console.log(`Default org set to ${name ?? org} (${id})`);
    });
}
