import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CliConfig = {
  defaultOrg?: string;
  apiUrl?: string;
  backend?: "local" | "hosted";
};

export const CONFIG_KEYS = ["defaultOrg", "apiUrl", "backend"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "gauge");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): CliConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as CliConfig)
      : {};
  } catch {
    return {};
  }
}

export function writeConfig(config: CliConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function updateConfig(patch: Partial<CliConfig>): CliConfig {
  const next: CliConfig = { ...readConfig(), ...patch };
  for (const key of CONFIG_KEYS) {
    if (next[key] === undefined) delete next[key];
  }
  writeConfig(next);
  return next;
}
