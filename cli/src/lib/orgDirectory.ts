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
      "Legacy Agents tokens cannot access the Gauge organization directory.",
      {
        hint: "Run `gauge auth login` and unset GAUGE_API_TOKEN if it contains a legacy token.",
      },
    );
  // Lazy import breaks the chatApi -> context -> orgDirectory cycle.
  const { chatPath, createChatApiClient } = await import("./chatApi");
  const { data } = await createChatApiClient().get<{ data: DirectoryOrg[] }>(
    chatPath("orgs"),
  );
  if (!Array.isArray(data))
    throw new CliError("internal", "Unexpected organization list response");
  return data;
}

export async function findOrganization(value: string): Promise<DirectoryOrg> {
  const org = (await fetchDirectory()).find(
    (org) => org.id === value || org.slug === value,
  );
  if (!org)
    throw new CliError(
      "not_found",
      `Organization "${value}" was not found in the Gauge directory.`,
      {
        hint: "Run `gauge orgs` and use one of the listed slugs.",
      },
    );
  return org;
}

export async function resolveOrgValue(value: string): Promise<ResolvedOrg> {
  // Canonical IDs are unambiguous; product APIs enforce access on every request.
  return isUuid(value) ? { id: value } : findOrganization(value);
}

export function legacySelection(source: OrgSource): never {
  const location =
    source === "config"
      ? "defaultOrg"
      : source === "project"
        ? "gauge.json org"
        : "the run specification's org";
  const hint =
    source === "config"
      ? "Run `gauge orgs`, then `gauge orgs use <slug>` to select your organization again."
      : source === "project"
        ? "Run `gauge orgs`, then `gauge orgs use <slug> --project` to select this project's organization again."
        : "Pass --org <slug> using a slug from `gauge orgs`, or remove org from the specification and use your saved selection.";
  throw new CliError(
    "usage",
    `The saved selection in ${location} uses the legacy Agents namespace. Please select a Gauge organization.`,
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
      "The server did not report this API key's organization.",
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
      "The workspace was created, but the server did not link it to a Gauge organization.",
      {
        hint: "Your previous selection is unchanged. Run `gauge orgs` before retrying creation.",
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
