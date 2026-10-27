import type { MeResponse } from "@withgauge/api-schemas/me";
import { CliError, createClient } from "./client";
import { resolveToken } from "./credentials";

export type Products = { chat: boolean; agents: boolean | null };
export type DirectoryOrg = {
  id: string;
  slug: string;
  name: string;
  products?: Products;
};
export type ResolvedOrg = { id: string; name?: string };
export type OrgSource = "flag" | "file" | "project" | "config";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_RE.test(value);

export type CredentialKind = "session" | "api_key" | "legacy" | "none";
export function credentialKind(token = resolveToken()): CredentialKind {
  if (!token) return "none";
  if (token.startsWith("gauge_cli_")) return "session";
  if (token.startsWith("gauge_sk_") || !token.startsWith("gauge_"))
    return "api_key";
  return "legacy";
}

export async function fetchDirectory(): Promise<DirectoryOrg[]> {
  if (credentialKind() === "legacy")
    throw new CliError(
      "usage",
      "This Agents token cannot list or select organizations in this version of the CLI.",
      {
        hint: "If GAUGE_API_TOKEN is set, unset it first. Then run `gauge auth login` and `gauge orgs`.",
      },
    );
  // Lazy import breaks the chatApi -> context -> orgDirectory cycle.
  const { chatPath, createChatApiClient } = await import("./chatApi");
  const { data } = await createChatApiClient().get<{ data: DirectoryOrg[] }>(
    chatPath("orgs"),
  );
  if (!Array.isArray(data))
    throw new CliError("internal", "Gauge returned an organization list the CLI could not read.", {
      hint: "Try `gauge orgs` again. If this continues, contact Gauge support.",
    });
  return data;
}

export async function findOrganization(value: string): Promise<DirectoryOrg> {
  const org = (await fetchDirectory()).find(
    (org) => org.id === value || org.slug === value,
  );
  if (!org)
    throw new CliError(
      "not_found",
      `You don't have access to an organization named "${value}".`,
      {
        hint: "Run `gauge orgs` to see your organizations, then use a value from the slug column.",
      },
    );
  return org;
}

export async function resolveOrgValue(value: string): Promise<ResolvedOrg> {
  // Canonical IDs are unambiguous; product APIs enforce access on every request.
  return isUuid(value) ? { id: value } : findOrganization(value);
}

export function legacySelection(source: OrgSource): never {
  const message =
    source === "config"
      ? "Your saved organization needs to be selected again after this CLI update."
      : source === "project"
        ? "This project's organization needs to be selected again after this CLI update."
        : "The organization in this run file needs to be selected again after this CLI update.";
  const hint =
    source === "config"
      ? "Run `gauge orgs` to see your organizations, then `gauge orgs use <slug>` to choose one. If you have only one organization, `gauge auth login` updates your saved choice automatically."
      : source === "project"
        ? "Run `gauge orgs`, then `gauge orgs use <slug> --project` to update gauge.json."
        : "Run `gauge orgs`, then rerun your command with --org <slug>. Or remove org from the run file to use your saved organization.";
  throw new CliError(
    "usage",
    message,
    { hint },
  );
}

export async function resolveSelection(
  value: string,
  source: OrgSource,
): Promise<ResolvedOrg> {
  if (source !== "flag" && !isUuid(value)) legacySelection(source);
  return resolveOrgValue(value);
}

export async function keyOrganization(): Promise<DirectoryOrg> {
  const { createChatApiClient } = await import("./chatApi");
  const org = (await createChatApiClient().me()).apiKey?.organization;
  if (!org)
    throw new CliError(
      "internal",
      "Gauge could not identify which organization this API key belongs to.",
      { hint: "Check the key in Settings → API Keys and try again." },
    );
  return org;
}

export async function createdOrganization(
  agentsSlug: string,
): Promise<DirectoryOrg> {
  const { orgs } = await createClient().get<MeResponse>("/api/v1/me");
  const id = orgs.find(
    (org) => org.slug === agentsSlug,
  )?.canonicalGaugeOrganizationId;
  if (!id)
    throw new CliError(
      "internal",
      "Your workspace was created, but it is not ready to select in the CLI yet.",
      {
        hint: "Run `gauge orgs` to check for it, then `gauge orgs use <slug>`. If it is missing, contact Gauge support; you don't need to create it again.",
      },
    );
  return findOrganization(id);
}

export async function missingAgentsOrg(
  org: string,
): Promise<CliError | undefined> {
  const match = (await fetchDirectory()).find((o) => o.id === org);
  if (match?.products?.agents !== false) return undefined;
  return new CliError("not_found", `${match.name} doesn't use Gauge Agents.`, {
    hint: "Run `gauge orgs` to see which products each organization uses.",
  });
}

export function productsLabel(products: Products | undefined): string {
  if (!products) return "unknown";
  return (
    [products.chat ? "Chat" : undefined, products.agents ? "Agents" : undefined]
      .filter(Boolean)
      .join(", ") || "-"
  );
}
