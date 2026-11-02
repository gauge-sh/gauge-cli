import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CredentialError, resolveSessionCredential, type AuthMode, type CredentialSources, type SessionSpec } from "@withgauge/local-execution";
import { CliError } from "./client";
import { configDir } from "./config";

export const LOCAL_TARGETS = {
  CLAUDE_CODE: { kind: "claude-code", model: "claude-sonnet-5-5" },
  CODEX_CLI: { kind: "codex", model: "gpt-6-astra" },
  PI: { kind: "pi", model: "openai-codex/gpt-6-astra" },
  OPENCODE: { kind: "opencode", model: "openai/gpt-6-astra" },
} as const;
const agents = ["CLAUDE_CODE", "CODEX_CLI", "PI", "OPENCODE"] as const;
const variable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const profileSchema = z.object({
  agent: z.enum(agents),
  provider: z.enum(["anthropic", "openai", "openai-codex", "fireworks", "openrouter"]),
  auth: z.enum(["api_key", "access_token", "setup_token"]),
  env: variable.optional(),
}).strict();
export type LocalProfile = z.infer<typeof profileSchema>;
const storeSchema = z.object({ version: z.literal(1), profiles: z.record(z.string(), profileSchema), defaults: z.record(z.string(), z.string()) }).strict();
export type ProfileStore = z.infer<typeof storeSchema>;
export type ResolvedLocalProfile = LocalProfile & { name: string | null; source: string; nativeDirectory?: string };
export type LocalCredentialOptions = { profile?: string; credentialSelections?: Record<string, ResolvedLocalProfile> };
export type CredentialReadiness = { agent: string; model: string; profile?: ResolvedLocalProfile; ready: boolean; expiresAt?: string; problem?: string; verification: "local" };
export const API_KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", fireworks: "FIREWORKS_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const profilePath = () => join(configDir(), "local-profiles.json");
export function readProfiles(): ProfileStore {
  let raw: string;
  try { raw = readFileSync(profilePath(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: {}, defaults: {} }; throw error; }
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {   }
  throw new CliError("usage", "Invalid local credential profile file.", { hint: `Repair ${profilePath()}.` });
}
export function writeProfiles(store: ProfileStore): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const temporary = `${profilePath()}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(storeSchema.parse(store), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, profilePath());
}
export function validateProfile(value: unknown): LocalProfile {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new CliError("usage", "Invalid profile. Supply a supported --agent, --provider and --auth, and an environment variable name with --env.");
  const p = parsed.data;
  const expectedProvider = p.agent === "CLAUDE_CODE" ? "anthropic" : p.agent === "CODEX_CLI" ? "openai" : undefined;
  if (expectedProvider && p.provider !== expectedProvider) throw new CliError("usage", `${p.agent} requires provider ${expectedProvider}.`);
  if (p.auth === "access_token") {
    const provider = p.agent === "CLAUDE_CODE" ? "anthropic" : p.agent === "PI" ? "openai-codex" : "openai";
    if (p.provider !== provider || p.env) throw new CliError("usage", `Native login for ${p.agent} requires provider ${provider} and no --env.`);
  } else if (p.auth === "setup_token") {
    if (p.agent !== "CLAUDE_CODE") throw new CliError("usage", "Setup tokens are supported only for CLAUDE_CODE.");
    p.env ??= "CLAUDE_CODE_OAUTH_TOKEN";
  } else {
    if (!API_KEY_ENV[p.provider]) throw new CliError("usage", `API-key auth is unsupported for ${p.provider}.`);
    p.env ??= API_KEY_ENV[p.provider];
  }
  return p;
}
export function setProfile(name: string, value: unknown, replace = false): ProfileStore {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) throw new CliError("usage", "Profile names must be 1–64 letters, digits, dots, underscores or hyphens.");
  const p = validateProfile(value);
  const store = readProfiles();
  const previous = Object.hasOwn(store.profiles, name) ? store.profiles[name] : undefined;
  if (previous && !replace) throw new CliError("usage", `Profile ${name} already exists. Pass --replace to update it.`);
  if (previous && previous.agent !== p.agent && store.defaults[previous.agent] === name) delete store.defaults[previous.agent];
  store.profiles[name] = p;
  writeProfiles(store);
  return store;
}
export function requireProfile(store: ProfileStore, name: string): LocalProfile {
  if (!Object.hasOwn(store.profiles, name)) throw new CliError("not_found", `Local credential profile ${name} does not exist.`, { hint: "Run gauge local profiles list." });
  return validateProfile(store.profiles[name]);
}
export function credentialKey(agent: string, model: string): string { return `${agent}:${model}`; }
function providerFor(agent: string, model: string): string {
  if (agent === "CLAUDE_CODE") return "anthropic";
  if (agent === "CODEX_CLI") return "openai";
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) throw new CliError("usage", `${agent} model ${model} must include provider/model.`);
  return model.slice(0, slash);
}
export function resolveLocalProfile(agent: string, model: string, options: LocalCredentialOptions = {}, store: ProfileStore | undefined = undefined, env: NodeJS.ProcessEnv = process.env): ResolvedLocalProfile {
  const key = credentialKey(agent, model);
  if (options.credentialSelections) {
    const selected = options.credentialSelections[key];
    if (!selected) throw new CliError("usage", `This batch has no saved login settings for ${agent} ${model}.`, { hint: "Check `gauge local profiles list`, then start a new batch with the profile you want to use." });
    validateCompatibility(selected, agent, model);
    return selected;
  }
  store ??= readProfiles();
  const provider = providerFor(agent, model);
  const name = options.profile ?? store.defaults[agent] ?? null;
  let p: LocalProfile;
  if (name) p = requireProfile(store, name);
  else {
    const apiEnv = API_KEY_ENV[provider];
    const nativeProvider = agent === "CLAUDE_CODE" ? "anthropic" : agent === "PI" ? "openai-codex" : "openai";
    const auth: AuthMode = (apiEnv && env[apiEnv]?.trim()) || provider !== nativeProvider ? "api_key" : agent === "CLAUDE_CODE" && env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ? "setup_token" : "access_token";
    p = validateProfile({ agent, provider, auth });
  }
  validateCompatibility(p, agent, model);
  const nativeDirectory = p.auth === "access_token" ? (p.agent === "CLAUDE_CODE" ? env.CLAUDE_CONFIG_DIR || undefined :env.CODEX_HOME || join(homedir(), ".codex")) : undefined;
  return { ...p, name, source: p.env ? `env:${p.env}` : p.agent === "CLAUDE_CODE" ? "native:claude" : "native:codex", ...(nativeDirectory ? { nativeDirectory } : {}) };
}
function validateCompatibility(p: LocalProfile, agent: string, model: string): void {
  validateProfile(pickProfile(p));
  if (p.agent !== agent || p.provider !== providerFor(agent, model)) throw new CliError("usage", `Credential profile for ${p.agent}/${p.provider} is incompatible with ${agent} ${model}.`, { hint: "Select a compatible --profile or change this harness's default with gauge local profiles use." });
}
function pickProfile(p: LocalProfile): LocalProfile { return { agent: p.agent, provider: p.provider, auth: p.auth, ...(p.env ? { env: p.env } : {}) }; }
export function profileCredentialSources(profile: ResolvedLocalProfile, env: NodeJS.ProcessEnv = process.env): CredentialSources {
  const mapped = { ...env };
  if (profile.env) {
    if (!env[profile.env]?.trim()) throw new CredentialError(`Credential environment variable ${profile.env} is not set.`, `Export ${profile.env} before starting the batch, or update the profile's --env reference.`);
    const canonical = profile.auth === "setup_token" ? "CLAUDE_CODE_OAUTH_TOKEN" : API_KEY_ENV[profile.provider];
    mapped[canonical] = env[profile.env];
  }
  if (profile.nativeDirectory) mapped[profile.agent === "CLAUDE_CODE" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = profile.nativeDirectory;
  return { env: mapped, homeDir: homedir(), now: new Date() };
}
export function readinessSpec(agent: string, model: string, profile: ResolvedLocalProfile): SessionSpec {
  return { image: "unused", agent: { kind: LOCAL_TARGETS[agent as keyof typeof LOCAL_TARGETS].kind, model }, auth: { mode: profile.auth }, workspace: null, resources: [], prompt: { text: "" }, limits: { turnTimeoutS: 1800, responseTimeoutS: 60, maxTurns: 1 } };
}
export async function inspectLocalCredential(agent: string, model: string, options: LocalCredentialOptions = {}, store?: ProfileStore): Promise<CredentialReadiness> {
  let profile: ResolvedLocalProfile | undefined;
  try {
    profile = resolveLocalProfile(agent, model, options, store);
    const credential = await resolveSessionCredential(readinessSpec(agent, model, profile), profileCredentialSources(profile));
    return { agent, model, profile, ready: true, ...(credential.expiresAt ? { expiresAt: credential.expiresAt.toISOString() } : {}), verification: "local" };
  } catch (error) {
    const problem = error instanceof CredentialError ? `${error.message} Fix: ${error.remedy}` : error instanceof CliError ? error.message : "Could not read the credential source. Repair or renew the native login and retry.";
    return { agent, model, profile, ready: false, problem, verification: "local" };
  }
}
