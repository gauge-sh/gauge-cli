import type { MeResponse } from "@withgauge/api-schemas/me";
import type { CreateOrgResponse } from "@withgauge/api-schemas/orgs";
import { deviceLogin } from "../commands/auth";
import { ApiClient, CliError } from "./client";
import { readConfig, updateConfig } from "./config";
import { credentialsPath, resolveToken, saveToken } from "./credentials";

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
    saveToken(login.token);
    me = login.me;
    client = new ApiClient({ token: login.token });
    log(
      `\nSigned in as ${me.user.email ?? me.user.id} — token saved to ${credentialsPath()}.`,
    );
  }

  const wantNewOrg =
    opts.new === true || opts.orgName !== undefined || me.orgs.length === 0;
  let org: string;
  let createdOrg: CreateOrgResponse | null = null;
  const website = opts.website ?? websiteFromEmail(me.user.email);
  if (wantNewOrg) {
    const name = opts.orgName?.trim() || orgNameFromEmail(me.user.email);
    createdOrg = await client.post<CreateOrgResponse>("/api/v1/orgs", {
      name,
      website,
    });
    org = createdOrg.slug;
  } else {
    org = readConfig().defaultOrg ?? me.orgs[0]?.slug ?? "";
    if (!org)
      throw new CliError(
        "internal",
        "No workspace available; re-run with --org-name to create one.",
      );
  }
  updateConfig({ defaultOrg: org });
  log(
    createdOrg
      ? `Created workspace ${createdOrg.name} (${org}).`
      : `Using workspace ${org}.`,
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
  return { user: me.user, org, createdOrg, seeded };
}
