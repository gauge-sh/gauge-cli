import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MeOrg, MeResponse } from "@withgauge/api-schemas/me";
import { CliError, createClient } from "./client";
import { configDir, readConfig, updateConfig } from "./config";
import { resolveToken } from "./credentials";
import { storedSharedCredentials } from "./sharedAuth";

export type Products = { chat: boolean; agents: boolean | null };

export type DirectoryOrg = {
  id: string;
  slug: string;
  name: string;
  // Older servers omit products and list only Chat organizations.
  products?: Products;
};

export type AgentsOrg = MeOrg;

export type ResolvedOrg = {
  // Unlinked Agents workspaces retain their slug instead of a shared UUID.
  id: string;
  name?: string;
  via: "uuid" | "chat" | "agents" | "agents_unlinked" | "unresolved";
};

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

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type CachedOrg = { id: string; name?: string; via: ResolvedOrg["via"] };
type Cache = {
  version: 1;
  credential: string;
  orgs: Record<string, CachedOrg & { at: number }>;
  keyOrg?: DirectoryOrg & { at: number };
  hinted?: string[];
};

export function orgCachePath(): string {
  return join(configDir(), "org-cache.json");
}

function credentialId(): string {
  const shared = storedSharedCredentials();
  // A session ID survives access-token rotation.
  const raw = shared?.sessionId
    ? `${shared.authUrl}#${shared.sessionId}`
    : (resolveToken() ?? "");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function readCache(): Cache {
  const credential = credentialId();
  try {
    const value = JSON.parse(readFileSync(orgCachePath(), "utf8")) as Cache;
    if (value?.version === 1 && value.credential === credential) return value;
  } catch {}
  return { version: 1, credential, orgs: {} };
}

function saveCache(cache: Cache): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(orgCachePath(), `${JSON.stringify(cache)}\n`, "utf8");
  } catch {}
}

const fresh = (at: number | undefined) =>
  at !== undefined && Date.now() - at < CACHE_TTL_MS;

function cached(value: string): CachedOrg | undefined {
  const entry = readCache().orgs[value];
  return entry && fresh(entry.at) ? entry : undefined;
}

function remember(value: string, org: CachedOrg): void {
  const cache = readCache();
  cache.orgs[value] = { ...org, at: Date.now() };
  saveCache(cache);
}

export async function fetchDirectory(): Promise<DirectoryOrg[]> {
  // Lazy import breaks the chatApi -> context -> orgDirectory cycle.
  const { chatPath, createChatApiClient } = await import("./chatApi");
  const { data } = await createChatApiClient().get<{ data: DirectoryOrg[] }>(
    chatPath("orgs"),
  );
  if (!Array.isArray(data))
    throw new CliError("internal", "Unexpected organization list response");
  return data;
}

export async function fetchAgentsOrgs(): Promise<AgentsOrg[]> {
  const { orgs } = await createClient().get<MeResponse>("/api/v1/me");
  if (!Array.isArray(orgs))
    throw new CliError("internal", "Unexpected organization list response");
  return orgs;
}

const quietly = <T>(promise: Promise<T>): Promise<T | null> =>
  promise.catch(() => null);

export async function resolveOrgValue(value: string): Promise<ResolvedOrg> {
  if (isUuid(value)) return { id: value, via: "uuid" };
  const kind = credentialKind();
  if (kind === "legacy" || kind === "none")
    return { id: value, via: "unresolved" };
  const hit = cached(value);
  if (hit) return hit;
  const [directory, agentsOrgs] = await Promise.all([
    quietly(fetchDirectory()),
    kind === "api_key" ? null : quietly(fetchAgentsOrgs()),
  ]);
  const chat = directory?.find((org) => org.slug === value);
  const agents = agentsOrgs?.find((org) => org.slug === value);
  const canonical = agents?.canonicalGaugeOrganizationId ?? undefined;
  if (chat && agents && canonical !== chat.id)
    throw new CliError(
      "usage",
      `"${value}" names two organizations: ${chat.name} (${chat.id}) in Gauge Chat and the Gauge Agents workspace ${agents.name}${canonical ? ` (${canonical})` : ""}.`,
      {
        hint: "Pass the organization's id instead. `gauge orgs` lists ids.",
      },
    );
  let resolved: ResolvedOrg;
  if (chat) resolved = { id: chat.id, name: chat.name, via: "chat" };
  else if (canonical)
    resolved = { id: canonical, name: agents?.name, via: "agents" };
  else if (agents)
    resolved = { id: value, name: agents.name, via: "agents_unlinked" };
  else return { id: value, via: "unresolved" };
  remember(value, resolved);
  return resolved;
}

export async function keyOrganization(): Promise<DirectoryOrg | undefined> {
  const cache = readCache();
  if (cache.keyOrg && fresh(cache.keyOrg.at)) return cache.keyOrg;
  const { chatPath, createChatApiClient } = await import("./chatApi");
  const me = await createChatApiClient().get<{
    apiKey: { organization?: DirectoryOrg } | null;
  }>(chatPath("me"));
  const org = me.apiKey?.organization;
  if (org) {
    cache.keyOrg = { ...org, at: Date.now() };
    saveCache(cache);
  }
  return org;
}

export type OrgSource = "flag" | "file" | "project" | "config";

export async function resolveSelection(
  value: string,
  source: OrgSource,
): Promise<ResolvedOrg> {
  const resolved = await resolveOrgValue(value);
  if (resolved.via !== "agents") return resolved;
  if (source === "config" && readConfig().defaultOrg === value) {
    updateConfig({ defaultOrg: resolved.id });
    console.error(
      `Default org ${value} is now stored as its organization id ${resolved.id}${resolved.name ? ` (${resolved.name})` : ""}.`,
    );
  } else if (source === "project") {
    const cache = readCache();
    if (!cache.hinted?.includes(value)) {
      cache.hinted = [...(cache.hinted ?? []), value];
      saveCache(cache);
      console.error(
        `gauge.json org "${value}" is a Gauge Agents workspace slug. Consider setting it to the organization id ${resolved.id} (or its Gauge Chat slug), which Gauge Chat and Gauge Agents both accept.`,
      );
    }
  }
  return resolved;
}

export async function missingAgentsOrg(
  org: string,
): Promise<CliError | undefined> {
  if (credentialKind() === "legacy") return undefined;
  const directory = await quietly(fetchDirectory());
  const match = directory?.find((o) => o.id === org || o.slug === org);
  if (!match || match.products?.agents !== false) return undefined;
  return new CliError("not_found", `${match.name} doesn't use Gauge Agents.`, {
    hint: "Run `gauge orgs` to see which products each organization uses.",
  });
}

export function productsLabel(products: Products): string {
  const names = [
    products.chat ? "Chat" : undefined,
    products.agents ? "Agents" : undefined,
  ].filter(Boolean);
  return names.join(", ") || "-";
}
