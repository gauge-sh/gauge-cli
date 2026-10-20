import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { PI_AGENT_DIR, splitModel } from "./scripts.js";
import type { SessionSpec } from "./types.js";

export interface SessionCredential {
  files: { name: string; contents: string; target: string; readonly: boolean }[];
  exports: string[];
  expiresAt?: Date;
}

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}

export interface CredentialSources {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  now: Date;
  readFile?: (path: string) => Promise<string | undefined>;
  readKeychain?: () => Promise<string | undefined>;
}

const RENEWAL_MARGIN_S = 300;

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readClaudeKeychain(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await promisify(execFile)("security", [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ]);
    return stdout;
  } catch {
    return undefined;
  }
}

function jwtExpiry(token: string): Date | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" ? new Date(exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

function envFile(name: string, value: string, variable: string): SessionCredential {
  const target = `/run/gauge/${name}`;
  return {
    files: [{ name, contents: value, target, readonly: true }],
    exports: [`export ${variable}="$(cat ${target})"`],
  };
}

async function claudeCredential(
  spec: SessionSpec,
  src: CredentialSources,
  read: (path: string) => Promise<string | undefined>,
): Promise<SessionCredential> {
  switch (spec.auth.mode) {
    case "setup_token": {
      const token = src.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
      if (!token)
        throw new CredentialError(
          "CLAUDE_CODE_OAUTH_TOKEN is not set.",
          "Set CLAUDE_CODE_OAUTH_TOKEN, or use the Claude Code login on this machine.",
        );
      return envFile("claude-token", token, "CLAUDE_CODE_OAUTH_TOKEN");
    }
    case "api_key":
      return providerApiKey("anthropic", src);
    case "access_token": {
      const { access, expiresAt } = await claudeLogin(spec, src, read);
      return { ...envFile("claude-token", access, "CLAUDE_CODE_OAUTH_TOKEN"), expiresAt };
    }
  }
}

async function claudeLogin(
  spec: SessionSpec,
  src: CredentialSources,
  read: (path: string) => Promise<string | undefined>,
): Promise<{ access: string; expiresAt: Date }> {
  const configDir = src.env.CLAUDE_CONFIG_DIR || join(src.homeDir, ".claude");
  const raw =
    (await (src.readKeychain ?? readClaudeKeychain)()) ?? (await read(join(configDir, ".credentials.json")));
  let login: { accessToken?: unknown; expiresAt?: unknown } | undefined;
  try {
    login = raw ? (JSON.parse(raw) as { claudeAiOauth?: typeof login }).claudeAiOauth : undefined;
  } catch {
    login = undefined;
  }
  if (typeof login?.accessToken !== "string" || typeof login.expiresAt !== "number")
    throw new CredentialError(
      "No Claude Code login found on this machine.",
      "Run `claude` on this machine and log in, or set ANTHROPIC_API_KEY.",
    );
  const expiresAt = new Date(login.expiresAt);
  const needed = spec.limits.turnTimeoutS + RENEWAL_MARGIN_S;
  if (expiresAt.getTime() - src.now.getTime() < needed * 1000)
    throw new CredentialError(
      `The Claude Code login expires at ${expiresAt.toISOString()}, too soon for a ${spec.limits.turnTimeoutS}s turn.`,
      "Run `claude -p ok` once on this machine to renew its login.",
    );
  return { access: login.accessToken, expiresAt };
}

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  last_refresh?: string;
  tokens?: {
    access_token?: string;
    id_token?: string;
    account_id?: string;
    refresh_token?: string;
  };
}

async function chatGptLogin(
  spec: SessionSpec,
  src: CredentialSources,
  read: (path: string) => Promise<string | undefined>,
): Promise<{ auth: CodexAuthFile; access: string; accountId: string | undefined; expiresAt: Date }> {
  const home = src.env.CODEX_HOME || join(src.homeDir, ".codex");
  const raw = await read(join(home, "auth.json"));
  let auth: CodexAuthFile | undefined;
  try {
    auth = raw ? (JSON.parse(raw) as CodexAuthFile) : undefined;
  } catch {
    throw new CredentialError("The native Codex login file is invalid.", "Run `codex login` on this machine to replace it.");
  }
  const access = auth?.tokens?.access_token;
  if (!auth || auth.auth_mode !== "chatgpt" || !access)
    throw new CredentialError(
      "No ChatGPT login found (Codex's ~/.codex/auth.json).",
      "Run `codex login` on this machine, or select API-key auth.",
    );
  const expiresAt = jwtExpiry(access);
  const needed = spec.limits.turnTimeoutS + RENEWAL_MARGIN_S;
  if (!expiresAt || expiresAt.getTime() - src.now.getTime() < needed * 1000)
    throw new CredentialError(
      `The ChatGPT access token ${expiresAt ? `expires at ${expiresAt.toISOString()}` : "has no readable expiry"}, too soon for a ${spec.limits.turnTimeoutS}s turn.`,
      "Run `codex` once on this machine to renew its login.",
    );
  return { auth, access, accountId: auth.tokens?.account_id, expiresAt };
}

const API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

function providerApiKey(provider: string, src: CredentialSources): SessionCredential {
  const variable = API_KEY_ENV[provider];
  if (!variable)
    throw new CredentialError(
      `API-key auth is not supported for provider ${provider}.`,
      `Use one of: ${Object.keys(API_KEY_ENV).join(", ")}.`,
    );
  const key = src.env[variable]?.trim();
  if (!key)
    throw new CredentialError(
      `API-key mode was selected but ${variable} is not set.`,
      `Export ${variable}, or select subscription auth.`,
    );
  return envFile(variable.toLowerCase().replace(/_/g, "-"), key, variable);
}

function noClaudeSubscription(agent: string): never {
  throw new CredentialError(
    `Claude subscriptions are supported only in Claude Code, not ${agent}.`,
    "Use an Anthropic API key, or a ChatGPT login with an openai model.",
  );
}

async function codexCredential(
  spec: SessionSpec,
  src: CredentialSources,
  read: (path: string) => Promise<string | undefined>,
): Promise<SessionCredential> {
  switch (spec.auth.mode) {
    case "access_token": {
      const { auth, expiresAt } = await chatGptLogin(spec, src, read);
      const stripped: CodexAuthFile = {
        ...auth,
        OPENAI_API_KEY: null,
        tokens: { ...auth.tokens, refresh_token: "" },
      };
      return {
        files: [
          {
            name: "codex-auth.json",
            contents: JSON.stringify(stripped),
            target: "/run/gauge/codex-auth.json",
            readonly: true,
          },
        ],
        exports: ["cp /run/gauge/codex-auth.json /gauge/session/codex/auth.json", "chmod 600 /gauge/session/codex/auth.json"],
        expiresAt,
      };
    }
    case "api_key": {
      const credential = providerApiKey("openai", src);
      return {
        ...credential,
        exports: [
          ...credential.exports,
          "codex login --with-api-key < /run/gauge/openai-api-key",
        ],
      };
    }
    case "setup_token":
      throw new CredentialError(
        "setup-token auth applies to Claude only.",
        "Use the existing ChatGPT login or an API key for Codex.",
      );
  }
}

async function openCodeCredential(
  spec: SessionSpec,
  src: CredentialSources,
  read: (path: string) => Promise<string | undefined>,
): Promise<SessionCredential> {
  const { provider } = splitModel(spec.agent.model);
  switch (spec.auth.mode) {
    case "access_token": {
      if (provider !== "openai")
        throw new CredentialError(
          `A ChatGPT login serves only openai/* models in OpenCode, not ${provider}.`,
          "Choose an openai/<model>, or select API-key auth.",
        );
      const { access, accountId, expiresAt } = await chatGptLogin(spec, src, read);
      const content = JSON.stringify({
        openai: { type: "oauth", access, refresh: "", expires: expiresAt.getTime(), accountId },
      });
      return { ...envFile("opencode-auth.json", content, "OPENCODE_AUTH_CONTENT"), expiresAt };
    }
    case "api_key":
      return providerApiKey(provider, src);
    case "setup_token":
      return noClaudeSubscription("OpenCode");
  }
}

async function piCredential(
  spec: SessionSpec,
  src: CredentialSources,
  read: (path: string) => Promise<string | undefined>,
): Promise<SessionCredential> {
  const { provider } = splitModel(spec.agent.model);
  const agentDir = `mkdir -p ${PI_AGENT_DIR}`;
  switch (spec.auth.mode) {
    case "access_token": {
      if (provider !== "openai-codex")
        throw new CredentialError(
          `A ChatGPT login serves only openai-codex/* models in Pi, not ${provider}.`,
          "Choose an openai-codex/<model>, or select API-key auth.",
        );
      const { access, accountId, expiresAt } = await chatGptLogin(spec, src, read);
      const target = "/run/gauge/pi-auth.json";
      return {
        files: [
          {
            name: "pi-auth.json",
            contents: JSON.stringify({
              "openai-codex": { type: "oauth", access, refresh: "", expires: expiresAt.getTime(), accountId },
            }),
            target,
            readonly: true,
          },
        ],
        exports: [agentDir, `cp ${target} ${PI_AGENT_DIR}/auth.json`, `chmod 600 ${PI_AGENT_DIR}/auth.json`],
        expiresAt,
      };
    }
    case "api_key": {
      const credential = providerApiKey(provider, src);
      return { ...credential, exports: [agentDir, ...credential.exports] };
    }
    case "setup_token":
      return noClaudeSubscription("Pi");
  }
}

export async function resolveSessionCredential(
  spec: SessionSpec,
  src: CredentialSources,
): Promise<SessionCredential> {
  const read = src.readFile ?? readOptional;
  switch (spec.agent.kind) {
    case "claude-code":
      return claudeCredential(spec, src, read);
    case "codex":
      return codexCredential(spec, src, read);
    case "opencode":
      return openCodeCredential(spec, src, read);
    case "pi":
      return piCredential(spec, src, read);
  }
}
