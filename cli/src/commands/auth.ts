import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { errorEnvelopeSchema } from "@withgauge/api-schemas";
import {
  type CliAuthorizationTokenResponse,
  cliAuthorizationTokenResponseSchema,
} from "@withgauge/api-schemas/cli-auth";
import type { DeviceAuthorizeResponse } from "@withgauge/api-schemas/device";
import { deviceTokenResultSchema } from "@withgauge/api-schemas/device";
import type { MeResponse } from "@withgauge/api-schemas/me";
import type {
  ApiTokenItem,
  CreateTokenResponse,
} from "@withgauge/api-schemas/tokens";
import type { Command } from "commander";
import {
  ApiClient,
  CliError,
  createClient,
  createChatClient,
  resolveBaseUrl,
  USER_AGENT,
} from "../lib/client";
import { readConfig, updateConfig } from "../lib/config";
import { hostedOnly, resolveOutput } from "../lib/context";
import {
  clearToken,
  readCredentials,
  saveCredentials,
  type SharedCredentials,
  withCredentialLock,
  credentialsPath,
  resolveToken,
  saveToken,
} from "../lib/credentials";
import type { OutputFormat } from "../lib/output";
import { printItems, printJson } from "../lib/output";
import { fetchAllPages } from "../lib/paginate";

import {
  resolveAuthUrl,
  sharedLoginEnabled,
  sharedTokenSchema,
} from "../lib/sharedAuth";

const LOGIN_TIMEOUT_MS = 2 * 60 * 1000;
const TOKEN_PREFIX = "gauge_";

type TokenSource = "env" | "file" | "none";

function tokenSource(): TokenSource {
  if (process.env.GAUGE_API_TOKEN?.trim()) return "env";
  return resolveToken() ? "file" : "none";
}

export type ChatMeResponse = {
  user: { id: string; email: string | null; name: string };
  orgs: Array<{ id: string; slug: string; name: string }>;
};
type IdentityResponse = ChatMeResponse | MeResponse;
async function fetchMe(
  client: ApiClient,
  shared = false,
): Promise<IdentityResponse> {
  return shared
    ? client.get<ChatMeResponse>("/api/cli/me")
    : client.get<MeResponse>("/api/v1/me");
}
function identityClient(): { client: ApiClient; shared: boolean } {
  const shared = resolveToken()?.startsWith("gauge_cli_") ?? false;
  return { client: shared ? createChatClient() : createClient(), shared };
}
function authBase(): string {
  return sharedLoginEnabled() ? resolveAuthUrl() : resolveBaseUrl();
}
function sessionCredentials(raw: unknown): SharedCredentials {
  return {
    version: 1,
    sessionId: randomUUID(),
    ...sharedTokenSchema.parse(raw),
    authUrl: resolveAuthUrl(),
    apiUrl: resolveBaseUrl(),
  };
}
async function verifyIssuedToken(token: string): Promise<IdentityResponse> {
  const shared = token.startsWith("gauge_cli_");
  return fetchMe(
    new ApiClient({
      token,
      baseUrl: shared ? resolveAuthUrl() : resolveBaseUrl(),
    }),
    shared,
  );
}

export function parseLoopbackCallback(
  rawUrl: string | undefined,
  expectedState: string,
): string | null {
  const url = new URL(rawUrl ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") return null;
  if (
    url.searchParams.get("state") === expectedState &&
    url.searchParams.get("error") === "access_denied"
  ) {
    throw new CliError(
      "unauthorized",
      "Authorization was denied in the browser.",
    );
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== expectedState || !code) return null;
  return code;
}

function printIdentity(me: IdentityResponse): void {
  const orgs = me.orgs.map((o) => o.slug).join(", ") || "(none)";
  console.log(`Logged in as ${me.user.email ?? me.user.id}`);
  console.log(`Orgs: ${orgs}`);
  console.log(`API URL: ${resolveBaseUrl()}`);
}

export function useOnlyOrg(me: IdentityResponse, shared = false): void {
  const org = me.orgs.length === 1 ? me.orgs[0] : undefined;
  const only = org ? (shared && "id" in org ? org.id : org.slug) : undefined;
  if (!only || readConfig().defaultOrg) return;
  updateConfig({ defaultOrg: only });
  console.log(`Default org set to ${only}.`);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export async function browserLogin(): Promise<void> {
  const state = randomBytes(16).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const server = createServer();

  const codePromise = new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET" }).end();
        return;
      }
      let code: string | null;
      try {
        code = parseLoopbackCallback(req.url, state);
      } catch (error) {
        res
          .writeHead(200, { "content-type": "text/plain" })
          .end("Authorization denied. Return to your terminal.");
        reject(error);
        return;
      }
      if (!code) {
        res.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
        });
        res.end("Invalid callback. Retry gauge auth login.");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
      });
      res.end("Authorized. Return to your terminal.");
      resolve(code);
    });
    server.on("error", (e) =>
      reject(new CliError("network", `Loopback listener failed: ${e.message}`)),
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new CliError("internal", "Could not determine the listener port");
  }

  const base = authBase().replace(/\/+$/, "");
  const authorizeUrl = new URL(`${base}/cli/authorize`);
  authorizeUrl.searchParams.set("port", String(address.port));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("name", hostname() || "this device");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  console.log("Opening your browser to authorize the Gauge CLI…");
  console.log(`If it doesn't open, visit:

  ${authorizeUrl}
`);
  console.log("Waiting for browser authorization…");
  console.log(
    "No local network access or using SSH? Re-run with gauge auth login --device.",
  );
  openBrowser(authorizeUrl.toString());

  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await Promise.race([
      codePromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new CliError(
              "network",
              "Timed out waiting for browser authorization (2 minutes). " +
                "Retry, or use gauge auth login --device. New to Gauge? Sign-up needs a work email.",
            ),
          );
        }, LOGIN_TIMEOUT_MS);
      }),
    ]);

    const raw = await bootstrapPost<unknown>(
      sharedLoginEnabled() ? "/api/cli/token" : "/api/v1/cli/token",
      {
        code,
        codeVerifier,
      },
    );
    const parsed = (
      sharedLoginEnabled()
        ? sharedTokenSchema
        : cliAuthorizationTokenResponseSchema
    ).safeParse(raw);
    if (!parsed.success) {
      throw new CliError(
        "internal",
        "Unexpected response from the CLI token endpoint.",
      );
    }
    const exchange: CliAuthorizationTokenResponse = parsed.data;
    const token = exchange.accessToken;

    const me = await verifyIssuedToken(token);
    await withCredentialLock(async () => {
      if (sharedLoginEnabled()) saveCredentials(sessionCredentials(raw));
      else saveToken(token);
    });
    console.log(`Token saved to ${credentialsPath()}`);
    printIdentity(me);
    useOnlyOrg(me, token.startsWith("gauge_cli_"));
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

function deviceEndpoint(): string {
  return sharedLoginEnabled() ? "/api/cli/device" : "/api/v1/device";
}

async function bootstrapPost<T>(path: string, body: unknown): Promise<T> {
  const base = authBase().replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new CliError(
      "network",
      `Request to ${base} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    try {
      const parsed = errorEnvelopeSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        throw new CliError(parsed.data.error.code, parsed.data.error.message);
      }
    } catch (e) {
      if (e instanceof CliError) throw e;
    }
    throw new CliError(
      "internal",
      `Authentication request failed: HTTP ${res.status} ${res.statusText}`.trim(),
    );
  }
  return JSON.parse(text) as T;
}

export async function deviceLogin(opts: { email?: string }): Promise<{
  token: string;
  me: IdentityResponse;
  credentials?: SharedCredentials;
}> {
  const start = await bootstrapPost<DeviceAuthorizeResponse>(
    `${deviceEndpoint()}/authorize`,
    { deviceName: hostname() || "this device", email: opts.email },
  );

  console.log("To sign in, open this URL in a browser:\n");
  console.log(`  ${start.verificationUriComplete}\n`);
  console.log(`and confirm this code:  ${start.userCode}\n`);
  if (start.emailSent && opts.email) {
    console.log(`We also emailed a sign-in link to ${opts.email}.`);
  }
  console.log("Waiting for you to approve in the browser…");
  openBrowser(start.verificationUriComplete);

  const deadline = Date.now() + start.expiresIn * 1000;
  const MAX_TRANSIENT = 5;
  let interval = start.interval;
  let transient = 0;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    let raw: unknown;
    try {
      raw = await bootstrapPost<unknown>(`${deviceEndpoint()}/token`, {
        deviceCode: start.deviceCode,
      });
    } catch (e) {
      if (
        e instanceof CliError &&
        (e.code === "network" || e.code === "internal") &&
        ++transient <= MAX_TRANSIENT
      ) {
        continue;
      }
      throw e;
    }
    transient = 0;

    const parsed = deviceTokenResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CliError(
        "internal",
        "Unexpected response from the device token endpoint.",
      );
    }
    const result = parsed.data;
    switch (result.status) {
      case "pending":
        continue;
      case "slow_down":
        interval = result.interval;
        continue;
      case "denied":
        throw new CliError(
          "unauthorized",
          "Authorization was denied in the browser.",
        );
      case "expired":
        throw new CliError(
          "unauthorized",
          "The sign-in request expired before it was approved. Re-run it to try again.",
        );
      case "approved": {
        const token = result.accessToken;
        try {
          const credentials = sharedLoginEnabled()
            ? sessionCredentials(raw)
            : undefined;
          const me = await verifyIssuedToken(token);
          return { token, me, credentials };
        } catch (e) {
          throw new CliError(
            "network",
            `Authorization succeeded, but the issued token could not be verified ` +
              `(${e instanceof Error ? e.message : String(e)}). Re-run to try again; existing credentials were not changed.`,
          );
        }
      }
      default:
        throw new CliError(
          "internal",
          `Unexpected device authorization status: ${(result as { status: string }).status}`,
        );
    }
  }
  throw new CliError(
    "network",
    "Timed out waiting for browser approval. Re-run to try again. New to Gauge? Sign-up needs a work email.",
  );
}

export async function readStdin(
  input: Readable = process.stdin,
): Promise<string> {
  if ((input as Readable & { isTTY?: boolean }).isTTY) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      lines.close();
      return line;
    }
    return "";
  }

  let data = "";
  for await (const chunk of input) data += chunk;
  return data;
}

async function withTokenLogin(): Promise<void> {
  if (process.stdin.isTTY) {
    console.error("Paste your API token, then press Enter:");
  }
  const token = (await readStdin()).trim();
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new CliError(
      "usage",
      `Expected a token starting with ${TOKEN_PREFIX} on stdin`,
    );
  }
  const me = await verifyIssuedToken(token);
  await withCredentialLock(async () => {
    if (token.startsWith("gauge_cli_"))
      saveCredentials({
        version: 1,
        sessionId: randomUUID(),
        accessToken: token,
        authUrl: resolveAuthUrl(),
        apiUrl: resolveBaseUrl(),
      });
    else saveToken(token);
  });
  console.log(`Token saved to ${credentialsPath()}`);
  printIdentity(me);
  useOnlyOrg(me, token.startsWith("gauge_cli_"));
}

const TOKENS_PATH = "/api/v1/tokens";

async function fetchAllTokens(client: ApiClient): Promise<ApiTokenItem[]> {
  return fetchAllPages<ApiTokenItem>(client, TOKENS_PATH);
}

function tokenStatus(t: ApiTokenItem): "active" | "revoked" | "expired" {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt && Date.parse(t.expiresAt) <= Date.now()) return "expired";
  return "active";
}

function tokenRow(t: ApiTokenItem) {
  return {
    id: t.id,
    name: t.name,
    token: `…${t.last4}`,
    status: tokenStatus(t),
    created: t.createdAt.slice(0, 10),
    lastUsed: t.lastUsedAt ? t.lastUsedAt.slice(0, 10) : "never",
    expires: t.expiresAt ? t.expiresAt.slice(0, 10) : "never",
  };
}

function parseExpiresIn(raw: string): string | undefined {
  if (raw === "never") return undefined;
  const match = raw.match(/^(\d+)([dh])$/);
  if (!match) {
    throw new CliError(
      "usage",
      `Invalid --expires-in "${raw}" (expected e.g. 90d, 12h, or never)`,
    );
  }
  const n = Number(match[1]);
  const ms = match[2] === "d" ? n * 24 * 60 * 60 * 1000 : n * 60 * 60 * 1000;
  if (ms <= 0) {
    throw new CliError("usage", "--expires-in must be a positive duration");
  }
  return new Date(Date.now() + ms).toISOString();
}

async function whoami(output: OutputFormat): Promise<void> {
  const identity = identityClient();
  const me = await fetchMe(identity.client, identity.shared);
  if (output === "json") {
    printJson({ apiUrl: resolveBaseUrl(), ...me });
    return;
  }
  printIdentity(me);
}

export async function logout(): Promise<void> {
  await withCredentialLock(async () => {
    const stored = readCredentials();
    try {
      if (stored && typeof stored !== "string" && stored.refreshToken) {
        const response = await fetch(`${stored.authUrl}/api/cli/revoke`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: stored.refreshToken }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.error(
        `Warning: local credentials removed, but server revocation failed (${error instanceof Error ? error.message : String(error)}). The server grant may remain active.`,
      );
    } finally {
      clearToken();
    }
  });
}

export function register(program: Command): void {
  const auth = hostedOnly(program.command("auth"), {
    account: true,
  }).description("Authenticate the CLI");

  auth
    .command("login")
    .description("Log in via your browser (localhost callback flow)")
    .option("--with-token", "read a token from stdin (headless machines)")
    .option(
      "--device",
      "use a device code instead (no local network access required)",
    )
    .option(
      "--email <email>",
      "with --device: also email a sign-in link to this address",
    )
    .action(
      async (opts: {
        withToken?: boolean;
        device?: boolean;
        email?: string;
      }) => {
        if (opts.withToken && opts.device) {
          throw new CliError(
            "usage",
            "Choose only one of --with-token or --device.",
          );
        }
        if (opts.email && !opts.device) {
          throw new CliError("usage", "--email requires --device.");
        }
        if (opts.device) {
          const { token, me, credentials } = await deviceLogin({
            email: opts.email,
          });
          await withCredentialLock(async () => {
            if (credentials) saveCredentials(credentials);
            else saveToken(token);
          });
          console.log(`Token saved to ${credentialsPath()}`);
          printIdentity(me);
          useOnlyOrg(me, token.startsWith("gauge_cli_"));
        } else if (opts.withToken) {
          await withTokenLogin();
        } else {
          await browserLogin();
        }
      },
    );

  auth
    .command("logout")
    .description("Remove the stored token")
    .action(async () => {
      await logout();
      console.log(`Removed ${credentialsPath()}`);
      if (process.env.GAUGE_API_TOKEN?.trim()) {
        console.error(
          "warning: GAUGE_API_TOKEN is set in your environment and still wins; unset it to fully log out.",
        );
      }
    });

  auth
    .command("status")
    .description("Show the current auth state")
    .action(async (_opts: unknown, command: Command) => {
      const output = resolveOutput(command);
      const source = tokenSource();
      if (source === "none") {
        throw new CliError(
          "unauthorized",
          "Not logged in. Run `gauge auth login` or set GAUGE_API_TOKEN.",
        );
      }
      let me: IdentityResponse;
      try {
        const identity = identityClient();
        me = await fetchMe(identity.client, identity.shared);
      } catch (e) {
        if (e instanceof CliError && e.code === "unauthorized") {
          throw new CliError(
            "unauthorized",
            `Token (source: ${source}) was rejected — it may be revoked or expired. Run \`gauge auth login\`.`,
          );
        }
        throw e;
      }
      if (output === "json") {
        printJson({
          authenticated: true,
          source,
          apiUrl: resolveBaseUrl(),
          ...me,
        });
        return;
      }
      printIdentity(me);
      console.log(
        `Token source: ${source === "env" ? "GAUGE_API_TOKEN environment variable" : credentialsPath()}`,
      );
    });

  const tokens = auth
    .command("tokens")
    .description("Manage legacy Agents API tokens");

  tokens
    .command("list")
    .description("List your API tokens")
    .action(async (_opts: unknown, command: Command) => {
      const output = resolveOutput(command);
      const items = await fetchAllTokens(createClient());
      if (output === "json") {
        printJson(items);
        return;
      }
      printItems(items.map(tokenRow), "table");
    });

  tokens
    .command("create <name>")
    .description("Create an API token (the secret is shown exactly once)")
    .option("--expires-in <duration>", "e.g. 90d, 12h, or never", "never")
    .action(
      async (name: string, opts: { expiresIn: string }, command: Command) => {
        const output = resolveOutput(command);
        if (resolveToken()?.startsWith("gauge_cli_"))
          throw new CliError(
            "forbidden",
            "Shared CLI sessions cannot create legacy Agents tokens. Use an existing Agents credential to manage automation tokens.",
          );
        const expiresAt = parseExpiresIn(opts.expiresIn);
        const created = await createClient().post<CreateTokenResponse>(
          TOKENS_PATH,
          { name, ...(expiresAt ? { expiresAt } : {}) },
        );
        if (output === "json") {
          printJson(created);
          return;
        }
        console.log(
          `Created token "${created.name}" (id ${created.id}, expires ${created.expiresAt ?? "never"})`,
        );
        console.log(`\n  ${created.token}\n`);
        console.log("Store it now — it won't be shown again.");
      },
    );

  tokens
    .command("revoke <id>")
    .description("Revoke an API token")
    .action(async (id: string, _opts: unknown, command: Command) => {
      await createClient().delete<void>(
        `${TOKENS_PATH}/${encodeURIComponent(id)}`,
      );
      if (resolveOutput(command) !== "json") console.log(`Revoked ${id}`);
    });

  program
    .command("whoami")
    .description("Show the authenticated user and their orgs")
    .action(async (_opts: unknown, command: Command) => {
      await whoami(resolveOutput(command));
    });
}
