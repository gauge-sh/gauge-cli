import type { MeResponse } from "@withgauge/api-schemas/me";
import { createClient } from "./client";
import { createChatApiClient, type ChatMe } from "./chatApi";
import {
  credentialKind,
  fetchDirectory,
  type DirectoryOrg,
} from "./orgDirectory";

export type CredentialIdentity = {
  user: { id: string; email: string | null; name?: string } | null;
  apiKey: ChatMe["apiKey"];
  token: {
    kind: "session" | "api_key" | "legacy";
    scopes: string[] | null;
    expiresAt: string | null;
  };
};

export async function credentialIdentity(): Promise<CredentialIdentity> {
  if (credentialKind() === "legacy") {
    const { user } = await createClient().get<MeResponse>("/api/v1/me");
    return {
      user,
      apiKey: null,
      token: { kind: "legacy", scopes: null, expiresAt: null },
    };
  }
  return createChatApiClient().me();
}

export async function principalIdentity(): Promise<{
  user: CredentialIdentity["user"];
  apiKey: CredentialIdentity["apiKey"];
  orgs: DirectoryOrg[] | null;
}> {
  const { user, apiKey, token } = await credentialIdentity();
  const orgs =
    token.kind === "legacy"
      ? null
      : apiKey?.organization
        ? [apiKey.organization]
        : await fetchDirectory();
  return { user, apiKey, orgs };
}

export function printPrincipal(identity: {
  user: CredentialIdentity["user"];
  apiKey: CredentialIdentity["apiKey"];
  orgs?: DirectoryOrg[] | null;
}): void {
  const { user, apiKey, orgs } = identity;
  if (apiKey) console.log(`Org API key "${apiKey.name}" (${apiKey.prefix}…)`);
  else if (user)
    console.log(
      `Signed in as ${user.email || user.id}${user.name ? ` (${user.name})` : ""}`,
    );
  if (orgs)
    console.log(
      `Organizations: ${orgs.map((org) => `${org.name} (${org.slug})`).join(", ") || "(none)"}`,
    );
  else if (orgs === null)
    console.log("Use `gauge auth login` to list your Gauge organizations.");
}
