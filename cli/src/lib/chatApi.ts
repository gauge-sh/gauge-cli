import type { Command } from "commander";
import {
  ApiClient,
  type ApiClientOptions,
  CliError,
  type CliErrorCode,
  codeForStatus,
  type Query,
  retryAfterSeconds,
} from "./client";
import { readConfig } from "./config";
import { type OrgSelection, selectedOrg } from "./context";
import {
  credentialKind,
  fetchDirectory,
  keyOrganization,
  type OrgSource,
  resolveSelection,
} from "./orgDirectory";
import { type OutputFormat, printItems, printJson } from "./output";
import { resolveAuthUrl, storedSharedCredentials } from "./sharedAuth";

export const CHAT_API_PREFIX = "/api/v1";

// Maximum batch size accepted by the Chat API.
export const CHAT_BATCH_SIZE = 500;

export type Page<T> = { data: T[]; nextCursor?: string | null };

type ChatErrorBody = {
  error: { code: string; message: string; field?: string | null } & Record<
    string,
    unknown
  >;
};

const INVALID_CODES = new Set([
  "invalid_request",
  "invalid_query",
  "invalid_id",
  "invalid_cursor",
  "range_too_large",
]);

// Preserve the API error code separately from the CLI exit-code category.
function exitFamily(status: number, code: string): CliErrorCode {
  if (code === "limit_exceeded") return "insufficient_credits";
  if (status === 400 || status === 422 || INVALID_CODES.has(code))
    return "invalid_request";
  if (code === "rate_limited") return "rate_limited";
  return codeForStatus(status);
}

function isChatErrorBody(value: unknown): value is ChatErrorBody {
  const error = (value as ChatErrorBody | null)?.error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  );
}

const LOGIN_HINT =
  "Run `gauge auth login`, or set GAUGE_API_TOKEN to an org API key (Settings → API Keys).";

function hintFor(
  code: string,
  field: string | null | undefined,
  extra: Record<string, unknown>,
  retryAfter: number | undefined,
): string | undefined {
  switch (code) {
    case "forbidden":
      return field === "explain"
        ? "--explain (or `explain` in --json) is only available to Gauge staff; rerun without it."
        : undefined;
    case "unauthorized":
      return LOGIN_HINT;
    case "insufficient_scope":
      return `This credential needs the '${String(extra.requiredScope ?? "write")}' scope. If it is an org API key, create a Read & write key in Settings → API Keys.`;
    case "limit_exceeded":
      return typeof extra.remaining === "number"
        ? `Your plan allows ${extra.remaining} more prompt(s); nothing was created.`
        : "Nothing was created.";
    case "rate_limited":
      return retryAfter === undefined
        ? "Retry shortly."
        : `Retry in ${retryAfter} s.`;
    case "product_not_enabled":
      return "Run `gauge orgs` to see which products each organization uses.";
    default:
      return undefined;
  }
}

export type ChatMe = {
  user: { id: string; email: string; name: string } | null;
  apiKey: {
    id: string;
    name: string;
    prefix: string;
    organization?: import("./orgDirectory").DirectoryOrg;
  } | null;
  token: {
    kind: "session" | "api_key";
    scopes: string[];
    expiresAt: string | null;
  };
};

export function describeScopes(scopes: string[]): string {
  if (scopes.includes("write")) return "read & write";
  if (scopes.length === 1 && scopes[0] === "read") return "read-only";
  return scopes.length ? scopes.join(", ") : "no scopes";
}

export class ChatApiClient extends ApiClient {
  private describingScope = false;
  orgName?: string;

  // Unlike /api/cli/me, the public /me endpoint accepts organization API keys.
  async me(): Promise<ChatMe> {
    try {
      return await this.get<ChatMe>(chatPath("me"));
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "not_found")
        throw error;
      throw new CliError(
        "not_found",
        "not_found: this Gauge server does not report token identity yet (GET /api/v1/me is not available).",
        {
          hint: "Run `gauge orgs` to check that your credentials work.",
        },
      );
    }
  }

  private async scopeHint(required: unknown): Promise<string | undefined> {
    if (this.describingScope) return undefined;
    this.describingScope = true;
    try {
      const { token } = await this.me();
      const needs = String(required ?? "write");
      if (token.kind === "api_key")
        return `This org API key is ${describeScopes(token.scopes)} and needs '${needs}'.${needs === "write" ? " Create a Read & write key in Settings → API Keys." : ""}`;
      if (token.kind === "session")
        return `This login session has scopes [${token.scopes.join(", ")}] and needs '${needs}'. Ask an organization admin for write access, or use a Read & write org API key (Settings → API Keys).`;
      return undefined;
    } catch {
      return undefined;
    } finally {
      this.describingScope = false;
    }
  }

  constructor(options: ApiClientOptions = {}) {
    super({
      ...options,
      baseUrl:
        options.baseUrl ??
        storedSharedCredentials()?.authUrl ??
        resolveAuthUrl(),
    });
  }

  protected override headers(
    extra?: Record<string, string>,
  ): Record<string, string> {
    if (!this.signedIn)
      throw new CliError("unauthorized", "Not logged in to Gauge.", {
        hint: LOGIN_HINT,
      });
    return super.headers(extra);
  }

  protected override async toError(res: Response): Promise<CliError> {
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {}
    if (!isChatErrorBody(body)) {
      // Django returns HTML for unregistered routes.
      if (res.status === 404) return unknownEndpoint(res);
      return super.toError(res);
    }
    const { code, message, field, ...extra } = body.error;
    const retryAfter =
      typeof extra.retryAfter === "number"
        ? extra.retryAfter
        : res.status === 429
          ? retryAfterSeconds(res)
          : undefined;
    const details: Record<string, unknown> = {
      status: res.status,
      ...(field ? { field } : {}),
      ...extra,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
    if (code === "product_not_enabled" && this.orgName)
      return new CliError(
        exitFamily(res.status, code),
        `${this.orgName} doesn't use Gauge Chat.`,
        {
          apiCode: code,
          details,
          hint: hintFor(code, field, extra, retryAfter),
        },
      );
    return new CliError(
      exitFamily(res.status, code),
      `${code}: ${message}${field ? ` (field: ${field})` : ""}`,
      {
        apiCode: code,
        details,
        hint:
          (code === "insufficient_scope"
            ? await this.scopeHint(extra.requiredScope)
            : undefined) ?? hintFor(code, field, extra, retryAfter),
      },
    );
  }
}

function unknownEndpoint(res: Response): CliError {
  const url = res.url ? new URL(res.url) : undefined;
  return new CliError(
    "not_found",
    `not_found: ${url ? `${url.pathname} on ${url.host}` : "this path"} is not a Gauge Chat API endpoint (HTTP 404).`,
    {
      details: { status: 404 },
      hint: "This server may not support this command yet, or authUrl points at the wrong host.",
    },
  );
}

export function createChatApiClient(
  options: ApiClientOptions = {},
): ChatApiClient {
  return new ChatApiClient(options);
}

export function chatPath(...segments: string[]): string {
  return `${CHAT_API_PREFIX}/${segments.map(encodeURIComponent).join("/")}`;
}

export type Category = {
  id: string;
  slug: string;
  name: string;
  description: string;
};

type ChatGlobals = { org?: string; category?: string };

export type ChatOrg = {
  id: string;
  name?: string;
  source: OrgSource | "key" | "only";
};

export async function resolveChatOrg(command: Command): Promise<ChatOrg> {
  const { org } = command.optsWithGlobals<ChatGlobals>();
  const isKey = credentialKind() === "api_key";
  const selection: OrgSelection | undefined = isKey
    ? org
      ? { value: org, source: "flag" }
      : undefined
    : selectedOrg(command);
  if (selection) {
    const resolved = await resolveSelection(selection.value, selection.source);
    return { id: resolved.id, name: resolved.name, source: selection.source };
  }
  if (isKey) {
    const keyOrg = await keyOrganization();
    return { id: keyOrg.id, name: keyOrg.name, source: "key" };
  }
  const chatOrgs = (await fetchDirectory()).filter(
    (o) => o.products?.chat !== false,
  );
  if (chatOrgs.length === 1)
    return { id: chatOrgs[0].id, name: chatOrgs[0].name, source: "only" };
  throw new CliError(
    "usage",
    chatOrgs.length === 0
      ? "You are not a member of any organization with Gauge Chat."
      : `Several organizations have Gauge Chat (${chatOrgs.map((o) => o.slug).join(", ")}). Pass --org <org> or run \`gauge orgs use <org>\`.`,
  );
}

export async function resolveChatCategory(
  command: Command,
  client: ApiClient,
  org: ChatOrg,
): Promise<string> {
  const { category } = command.optsWithGlobals<ChatGlobals>();
  if (category) return category;
  const { chatCategory, chatCategoryOrg } = readConfig();
  if (
    chatCategory &&
    (chatCategoryOrg ? chatCategoryOrg === org.id : org.source === "config")
  )
    return chatCategory;
  const { data } = await client.get<Page<Category>>(
    chatPath("orgs", org.id, "categories"),
  );
  if (data.length === 1) return data[0].slug;
  const label = org.name ?? org.id;
  throw new CliError(
    "usage",
    data.length === 0
      ? `Organization ${label} has no categories.`
      : `Organization ${label} has several categories (${data.map((c) => c.slug).join(", ")}). Pass --category <slug> or run \`gauge chat categories use <slug>\`.`,
  );
}

export type ChatScope = {
  client: ChatApiClient;
  org: string;
  chatOrg: ChatOrg;
};
export type CategoryScope = ChatScope & { category: string; base: string[] };

export async function chatScope(command: Command): Promise<ChatScope> {
  const client = createChatApiClient();
  const chatOrg = await resolveChatOrg(command);
  client.orgName = chatOrg.name ?? chatOrg.id;
  return { client, org: chatOrg.id, chatOrg };
}

export async function categoryScope(command: Command): Promise<CategoryScope> {
  const scope = await chatScope(command);
  const category = await resolveChatCategory(
    command,
    scope.client,
    scope.chatOrg,
  );
  return {
    ...scope,
    category,
    base: ["orgs", scope.org, "categories", category],
  };
}

export type PageOptions = {
  limit?: string;
  cursor?: string;
  all?: boolean;
  max?: string;
};

export const DEFAULT_MAX_ITEMS = 5000;

export function parsePositive(
  raw: string | undefined,
  flag: string,
  max?: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || (max && value > max))
    throw new CliError(
      "usage",
      `${flag} must be an integer${max ? ` between 1 and ${max}` : " of at least 1"}`,
    );
  return value;
}

export async function fetchPages<T>(
  client: ApiClient,
  path: string,
  query: Query,
  options: PageOptions,
  maxLimit = 200,
): Promise<Page<T>> {
  const limit = parsePositive(options.limit, "--limit", maxLimit);
  if (!options.all)
    return client.get<Page<T>>(path, {
      ...query,
      limit,
      cursor: options.cursor,
    });
  const max = parsePositive(options.max, "--max") ?? DEFAULT_MAX_ITEMS;
  const data: T[] = [];
  let cursor = options.cursor;
  do {
    const page = await client.get<Page<T>>(path, {
      ...query,
      limit: Math.min(limit ?? maxLimit, max - data.length),
      cursor,
    });
    data.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && data.length < max);
  return { data, nextCursor: cursor ?? null };
}

export async function fetchAll<T>(
  client: ApiClient,
  path: string,
  query: Query = {},
): Promise<T[]> {
  return (await fetchPages<T>(client, path, query, { all: true })).data;
}

export function printPage<T>(
  page: Page<T>,
  output: OutputFormat,
  row: (item: T) => Record<string, unknown>,
): void {
  if (output === "json") {
    printJson({ data: page.data, nextCursor: page.nextCursor ?? null });
    return;
  }
  printItems(page.data.map(row), "table");
  if (page.nextCursor)
    console.error(
      `(more results — rerun with --cursor ${page.nextCursor}, or pass --all)`,
    );
}

export function addPageOptions(command: Command, maxLimit = 200): Command {
  return command
    .option("--limit <n>", `page size (1-${maxLimit})`)
    .option("--cursor <cursor>", "resume from a previous page's nextCursor")
    .option("--all", "follow nextCursor through every page")
    .option(
      "--max <n>",
      `with --all, stop after this many items (default ${DEFAULT_MAX_ITEMS})`,
    );
}

export function chunks<T>(items: T[], size = CHAT_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export const csv = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function truncate(text: string, length = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

type Topic = { id: string; slug: string; title: string };
type Tag = { id: string; name: string };

const lower = (s: string) => s.trim().toLowerCase();

export async function resolveTopicId(
  scope: CategoryScope,
  value: string,
): Promise<string> {
  if (value.startsWith("top_")) return value;
  const topics = await fetchAll<Topic>(
    scope.client,
    chatPath(...scope.base, "topics"),
  );
  const match = topics.filter(
    (t) => t.slug === value || lower(t.title) === lower(value),
  );
  if (match.length === 1) return match[0].id;
  throw new CliError(
    "not_found",
    match.length
      ? `Topic "${value}" is ambiguous; pass its id (${match.map((t) => t.id).join(", ")}).`
      : `Topic "${value}" not found in category ${scope.category}.`,
    {
      hint: "Run `gauge chat topics list`, or create it with `gauge chat topics create`.",
    },
  );
}

export async function resolveTagIds(
  scope: ChatScope,
  values: string[],
): Promise<string[]> {
  if (values.every((v) => v.startsWith("tag_"))) return values;
  const tags = await fetchAll<Tag>(
    scope.client,
    chatPath("orgs", scope.org, "tags"),
  );
  return values.map((value) => {
    if (value.startsWith("tag_")) return value;
    const match = tags.filter((t) => lower(t.name) === lower(value));
    if (match.length === 1) return match[0].id;
    throw new CliError(
      "not_found",
      match.length
        ? `Tag "${value}" is ambiguous; pass its id (${match.map((t) => t.id).join(", ")}).`
        : `Tag "${value}" not found.`,
      {
        hint: "Run `gauge chat tags list`, or create it with `gauge chat tags create`.",
      },
    );
  });
}

export function withCategory(command: Command): Command {
  return command.option(
    "--category <category>",
    "category slug or cat_ id (default: chatCategory config, else the org's only category)",
  );
}
