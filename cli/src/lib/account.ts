import type { MeResponse } from "@withgauge/api-schemas/me";
import type { CreateOrgResponse } from "@withgauge/api-schemas/orgs";
import { deviceLogin } from "../commands/auth";
import { ApiClient, CliError } from "./client";
import {
  type DirectoryOrg,
  createdOrganization,
  fetchDirectory,
  legacySelection,
} from "./orgDirectory";
import { readConfig, updateConfig } from "./config";
import {
  credentialsPath,
  resolveToken,
  saveCredentials,
  saveToken,
  withCredentialLock,
} from "./credentials";

export type AccountOptions = {
  email?: string;
  orgName?: string;
  website?: string;
  new?: boolean;
  seed?: boolean;
  log?: (line: string) => void;
};

export type SeedResult = {
  evalSets: number;
  visibilityPrompts: number;
  markets: number;
};

export type AccountResult = {
  user: MeResponse["user"];
  org: string;
  organization: DirectoryOrg;
  createdOrg: CreateOrgResponse | null;
  seeded: SeedResult | null;
};

const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

function emailDomain(email: string | null | undefined): string | undefined {
  const domain = email?.split("@")[1]?.toLowerCase();
  return domain && !PERSONAL_DOMAINS.has(domain) ? domain : undefined;
}

export function orgNameFromEmail(email: string | null | undefined): string {
  const base = emailDomain(email)?.split(".")[0] ?? "";
  if (!base) return "My Workspace";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function websiteFromEmail(
  email: string | null | undefined,
): string | undefined {
  const domain = emailDomain(email);
  return domain ? `https://${domain}` : undefined;
}

export async function ensureAccount(
  opts: AccountOptions = {},
): Promise<AccountResult> {
  const log = opts.log ?? console.log;
  let client: ApiClient;
  let me: MeResponse;
  if (resolveToken()) {
    client = new ApiClient();
    me = await client.get<MeResponse>("/api/v1/me");
    log(`Already signed in as ${me.user.email ?? me.user.id}.`);
  } else {
    const login = await deviceLogin({ email: opts.email });
    await withCredentialLock(async () => {
      if (login.credentials) saveCredentials(login.credentials);
      else saveToken(login.token);
    });
    client = new ApiClient();
    // Chat membership does not imply an Agents workspace exists or has the same slug.
    // Keep the successful shared login even if Agents onboarding is unavailable.
    me = await client.get<MeResponse>("/api/v1/me");
    log(
      `\nSigned in as ${me.user.email ?? me.user.id} — token saved to ${credentialsPath()}.`,
    );
  }

  const directory = await fetchDirectory();
  const wantNewOrg =
    opts.new === true || opts.orgName !== undefined || me.orgs.length === 0;
  let organization: DirectoryOrg;
  let createdOrg: CreateOrgResponse | null = null;
  const website = opts.website ?? websiteFromEmail(me.user.email);
  if (wantNewOrg) {
    const name = opts.orgName?.trim() || orgNameFromEmail(me.user.email);
    createdOrg = await client.post<CreateOrgResponse>("/api/v1/orgs", {
      name,
      website,
    });
    organization = await createdOrganization(createdOrg.slug);
  } else {
    const config = readConfig();
    if (!config.orgId && config.defaultOrg) legacySelection("config");
    const linkedIds = new Set(
      me.orgs.map((org) => org.canonicalGaugeOrganizationId).filter(Boolean),
    );
    const available = directory.filter((org) => linkedIds.has(org.id));
    const selected = config.orgId
      ? available.find((org) => org.id === config.orgId)
      : available.length === 1
        ? available[0]
        : undefined;
    if (selected) organization = selected;
    else
      throw new CliError(
        "usage",
        "Select a Gauge Agents organization before onboarding.",
        {
          hint: "Run `gauge orgs`, then `gauge orgs use <slug>`.",
        },
      );
  }
  const org = organization.id;
  updateConfig({ orgId: org, defaultOrg: undefined });
  log(
    createdOrg
      ? `Created workspace ${organization.name} (${organization.slug}).`
      : `Using workspace ${organization.name} (${organization.slug}).`,
  );

  let seeded: SeedResult | null = null;
  if (opts.seed !== false && createdOrg) {
    log("Seeding starter measurements (scanning your site)…");
    try {
      seeded = await client.post<SeedResult>(
        `/api/v1/orgs/${encodeURIComponent(org)}/onboarding/seed`,
        website ? { website } : {},
      );
      log(
        `Seeded ${seeded.evalSets} eval set(s) and ${seeded.visibilityPrompts} preference prompt(s)` +
          (seeded.markets ? ` across ${seeded.markets} market(s).` : "."),
      );
    } catch (e) {
      console.error(
        `warning: seeding skipped — ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return { user: me.user, org, organization, createdOrg, seeded };
}
