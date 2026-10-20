import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";

export function credentialsPath(): string {
  return join(configDir(), "credentials");
}

export function resolveToken(): string | null {
  const fromEnv = process.env.GAUGE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const stored = readFileSync(credentialsPath(), "utf8").trim();
    return stored || null;
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsPath(), `${token.trim()}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(credentialsPath(), 0o600);
}

export function clearToken(): void {
  rmSync(credentialsPath(), { force: true });
}
