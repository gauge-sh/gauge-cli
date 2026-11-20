import type { Command } from "commander";
import { CliError } from "../lib/client";
import { chatPath, createChatApiClient, type Page } from "../lib/chatApi";
import { confirmOrAbort } from "../lib/confirm";
import { hostedOnly, resolveOutput, selectedOrg } from "../lib/context";
import {
  credentialKind,
  fetchDirectory,
  resolveSelection,
} from "../lib/orgDirectory";
import { printItems, printJson } from "../lib/output";

export type ApiKeyAccess = "read" | "read_write";

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  access: ApiKeyAccess;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

export type CreatedApiKey = ApiKey & { key: string };

const EXPIRY_DAYS = [30, 90, 365] as const;
type ExpiryDays = (typeof EXPIRY_DAYS)[number];

export function parseAccess(raw: string): ApiKeyAccess {
  const value = raw.trim().toLowerCase();
  if (value === "read") return "read";
  if (value === "write" || value === "read_write" || value === "read-write")
    return "read_write";
  throw new CliError("usage", `--access must be read or write (got "${raw}")`);
}

export function parseExpiryDays(raw: string): ExpiryDays | null {
  const value = raw.trim().toLowerCase();
  if (value === "never") return null;
  const days = Number(value.replace(/d$/, ""));
  if ((EXPIRY_DAYS as readonly number[]).includes(days))
    return days as ExpiryDays;
  throw new CliError(
    "usage",
    `--expires-in must be 30d, 90d, 365d, or never (got "${raw}")`,
  );
}

function describeAccess(access: ApiKeyAccess): string {
  return access === "read_write" ? "read & write" : "read-only";
}

// Keys can only be managed by a signed-in person. A key that could mint keys
// would let a leaked credential outlive its own revocation.
function requireLogin(): void {
  const kind = credentialKind();
  if (kind === "session") return;
  if (kind === "none")
    throw new CliError("unauthorized", "Not logged in to Gauge.", {
      hint: "Run `gauge auth login`.",
    });
  throw new CliError(
    "forbidden",
    kind === "api_key"
      ? "API keys can't list, create, or revoke API keys. Sign in as a person instead."
      : "This older Agents token can't manage organization API keys.",
    {
      hint: process.env.GAUGE_API_TOKEN?.trim()
        ? "Unset GAUGE_API_TOKEN, then run `gauge auth login`."
        : "Run `gauge auth login`.",
    },
  );
}

type KeyOrg = { id: string; name: string };

async function resolveKeyOrg(command: Command): Promise<KeyOrg> {
  const selection = selectedOrg(command);
  if (selection) {
    const org = await resolveSelection(selection.value, selection.source);
    return { id: org.id, name: org.name ?? selection.value };
  }
  const orgs = await fetchDirectory();
  if (orgs.length === 1) return { id: orgs[0].id, name: orgs[0].name };
  throw new CliError(
    "usage",
    orgs.length === 0
      ? "You are not a member of any organization."
      : `You belong to several organizations (${orgs.map((o) => o.slug).join(", ")}). Pass --org <org> or run \`gauge orgs use <org>\`.`,
  );
}

async function keyScope(command: Command) {
  requireLogin();
  const org = await resolveKeyOrg(command);
  const client = createChatApiClient();
  return { org, client, base: ["orgs", org.id, "api-keys"] };
}

function keyRow(key: ApiKey): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    access: describeAccess(key.access),
    expires: key.expiresAt ?? "never",
    created: key.createdAt,
    "last used": key.lastUsedAt ?? "never",
  };
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("api-keys"), { account: true })
    .description("Organization API keys (gauge_sk_…) for scripts, CI, and connections")
    .addHelpText(
      "after",
      `
Org API keys act as one organization with read or read & write access. Set one
as GAUGE_API_TOKEN in CI or scripts. Managing keys needs a signed-in person
(\`gauge auth login\`); an API key cannot list, create, or revoke keys. --org
takes a slug or id (default: gauge.json orgId, then your saved default from
\`gauge orgs use\`, else your only organization). These are the same keys as
Settings → API Keys in the web app.`,
    );

  group
    .command("list")
    .description("List the organization's active API keys (never shows secrets)")
    .action(async (_opts: unknown, command: Command) => {
      const { client, base } = await keyScope(command);
      const page = await client.get<Page<ApiKey>>(chatPath(...base));
      if (resolveOutput(command) === "json") {
        printJson(page.data);
        return;
      }
      printItems(page.data.map(keyRow), "table");
    });

  group
    .command("create <name>")
    .description("Create an API key (the secret is shown exactly once)")
    .option("--access <access>", "read or write", "read")
    .option("--expires-in <duration>", "30d, 90d, 365d, or never", "never")
    .action(
      async (
        name: string,
        opts: { access: string; expiresIn: string },
        command: Command,
      ) => {
        if (!name.trim())
          throw new CliError("usage", "The key name cannot be blank.");
        const access = parseAccess(opts.access);
        const expiresInDays = parseExpiryDays(opts.expiresIn);
        const { org, client, base } = await keyScope(command);
        const created = await client.post<CreatedApiKey>(chatPath(...base), {
          name: name.trim(),
          access,
          expiresInDays,
        });
        if (resolveOutput(command) === "json") {
          printJson(created);
          return;
        }
        console.log(
          `Created ${describeAccess(created.access)} API key "${created.name}" for ${org.name} (id ${created.id}, expires ${created.expiresAt ?? "never"})`,
        );
        console.log(`\n  ${created.key}\n`);
        console.log("Store it now — it won't be shown again.");
      },
    );

  group
    .command("revoke <id>")
    .description("Revoke an API key; anything using it stops working immediately")
    .option(
      "-y, --yes",
      "skip the confirmation prompt (required when not on a TTY)",
    )
    .action(async (id: string, opts: { yes?: boolean }, command: Command) => {
      const { org, client, base } = await keyScope(command);
      const { data } = await client.get<Page<ApiKey>>(chatPath(...base));
      const key = data.find((k) => k.id === id);
      if (!key)
        throw new CliError(
          "not_found",
          `No active API key with id ${id} in ${org.name}.`,
          { hint: "Run `gauge api-keys list` to see key ids." },
        );
      await confirmOrAbort(
        `Revoke API key "${key.name}" (${key.prefix}…) in ${org.name}? Anything using it stops working immediately.`,
        opts.yes,
      );
      await client.delete<void>(chatPath(...base, key.id));
      if (resolveOutput(command) === "json")
        printJson({ id: key.id, name: key.name, revoked: true });
      else console.log(`Revoked API key "${key.name}" (${key.id})`);
    });
}
