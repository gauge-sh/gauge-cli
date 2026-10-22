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
import { type OutputFormat, printItems, printJson } from "./output";
import { resolveAuthUrl, storedSharedCredentials } from "./sharedAuth";

// The Gauge Chat public API (v1) lives on the Chat origin, the same origin that
// issues shared CLI credentials. Shared access tokens refresh through ApiClient;
// personal access tokens (gauge_pat_…) come from GAUGE_API_TOKEN.
export const CHAT_API_PREFIX = "/api/v1";

// Bulk endpoints accept at most this many items per request.
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

// Map a Chat error to the CLI's exit-code families: 2 for requests the caller
// must change, 3 for plan limits, 1 for everything else. The Chat code itself
// is reported verbatim (CliError.apiCode).
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
  "Run `gauge auth login`, or set GAUGE_API_TOKEN to a Gauge Chat personal access token (gauge_pat_…).";

function hintFor(
  code: string,
  extra: Record<string, unknown>,
  retryAfter: number | undefined,
): string | undefined {
  switch (code) {
    case "unauthorized":
      return LOGIN_HINT;
    case "insufficient_scope":
      return `This token needs the '${String(extra.requiredScope ?? "write")}' scope. Use a personal access token with that scope, or \`gauge auth login\`.`;
    case "limit_exceeded":
      return typeof extra.remaining === "number"
        ? `Your plan allows ${extra.remaining} more prompt(s); nothing was created.`
        : "Nothing was created.";
    case "rate_limited":
      return retryAfter === undefined
        ? "Retry shortly."
        : `Retry in ${retryAfter} s.`;
    case "product_not_enabled":
      return "Run `gauge chat orgs` to list organizations with Gauge Chat.";
    default:
      return undefined;
  }
}

export class ChatApiClient extends ApiClient {
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
      throw new CliError("unauthorized", "Not logged in to Gauge Chat.", {
        hint: LOGIN_HINT,
      });
    return super.headers(extra);
  }

  protected override async toError(res: Response): Promise<CliError> {
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {}
    if (!isChatErrorBody(body)) return super.toError(res);
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
    return new CliError(
      exitFamily(res.status, code),
      `${code}: ${message}${field ? ` (field: ${field})` : ""}`,
      { apiCode: code, details, hint: hintFor(code, extra, retryAfter) },
    );
  }
}

export function createChatApiClient(
  options: ApiClientOptions = {},
): ChatApiClient {
  return new ChatApiClient(options);
}

export function chatPath(...segments: string[]): string {
  return `${CHAT_API_PREFIX}/${segments.map(encodeURIComponent).join("/")}`;
}

export type Organization = { id: string; slug: string; name: string };
export type Category = {
  id: string;
  slug: string;
  name: string;
  description: string;
};

type ChatGlobals = { org?: string; category?: string };

// Org: --org, then `chatOrg` config, then the only Chat organization you belong to.
export async function resolveChatOrg(
  command: Command,
  client: ApiClient,
): Promise<string> {
  const { org } = command.optsWithGlobals<ChatGlobals>();
  if (org) return org;
  const { chatOrg } = readConfig();
  if (chatOrg) return chatOrg;
  const { data } = await client.get<Page<Organization>>(chatPath("orgs"));
  if (data.length === 1) return data[0].slug;
  throw new CliError(
    "usage",
    data.length === 0
      ? "You are not a member of any organization with Gauge Chat."
      : `Several organizations have Gauge Chat (${data.map((o) => o.slug).join(", ")}). Pass --org <slug> or run \`gauge chat orgs use <slug>\`.`,
  );
}

// Category: --category, then `chatCategory` config (only for the default org),
// then the org's only category.
export async function resolveChatCategory(
  command: Command,
  client: ApiClient,
  org: string,
): Promise<string> {
  const { category, org: orgFlag } = command.optsWithGlobals<ChatGlobals>();
  if (category) return category;
  const { chatOrg, chatCategory } = readConfig();
  if (chatCategory && (!orgFlag || orgFlag === chatOrg)) return chatCategory;
  const { data } = await client.get<Page<Category>>(
    chatPath("orgs", org, "categories"),
  );
  if (data.length === 1) return data[0].slug;
  throw new CliError(
    "usage",
    data.length === 0
      ? `Organization ${org} has no categories.`
      : `Organization ${org} has several categories (${data.map((c) => c.slug).join(", ")}). Pass --category <slug> or run \`gauge chat categories use <slug>\`.`,
  );
}

export type ChatScope = { client: ChatApiClient; org: string };
export type CategoryScope = ChatScope & { category: string; base: string[] };

export async function chatScope(command: Command): Promise<ChatScope> {
  const client = createChatApiClient();
  return { client, org: await resolveChatOrg(command, client) };
}

export async function categoryScope(command: Command): Promise<CategoryScope> {
  const { client, org } = await chatScope(command);
  const category = await resolveChatCategory(command, client, org);
  return {
    client,
    org,
    category,
    base: ["orgs", org, "categories", category],
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

// One page, or with --all every page up to --max items. When the cap stops
// paging early, nextCursor is kept so the caller can resume.
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

// Every page of an endpoint, for client-side name resolution.
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

// Accept a `top_` ID, or a topic slug or title in the category.
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

// Accept `tag_` IDs or tag names (case-insensitive).
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

// Commands scoped to one category take --category on the leaf command so it
// shows in that command's help.
export function withCategory(command: Command): Command {
  return command.option(
    "--category <category>",
    "category slug or cat_ id (default: chatCategory config, else the org's only category)",
  );
}
