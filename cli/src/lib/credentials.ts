import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { configDir } from "./config";
export type SharedCredentials = {
  version: 1;
  sessionId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  // Written before dispatch; only a confirmed, saved rotation clears it.
  refreshPending?: boolean;
  authUrl: string;
  apiUrl: string;
};
export function credentialsPath(): string {
  return join(configDir(), "credentials");
}
export function readCredentials(): string | SharedCredentials | null {
  try {
    const raw = readFileSync(credentialsPath(), "utf8").trim();
    if (!raw.startsWith("{")) return raw || null;
    const value = JSON.parse(raw);
    if (
      value.version !== 1 ||
      typeof value.accessToken !== "string" ||
      typeof value.authUrl !== "string" ||
      typeof value.apiUrl !== "string"
    )
      return null;
    return value as SharedCredentials;
  } catch {
    return null;
  }
}
export function resolveToken(): string | null {
  const fromEnv = process.env.GAUGE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stored = readCredentials();
  return typeof stored === "string" ? stored : (stored?.accessToken ?? null);
}
function atomicWrite(value: string): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const temporary = `${credentialsPath()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${value}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, credentialsPath());
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function saveToken(token: string): void {
  atomicWrite(token.trim());
}
export function saveCredentials(credentials: SharedCredentials): void {
  atomicWrite(JSON.stringify(credentials));
}
export function clearToken(): void {
  rmSync(credentialsPath(), { force: true });
}
export async function withCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = `${credentialsPath()}.lock`;
  const deadline = Date.now() + 35_000;
  while (true) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never unlink an observed stale lock: another process could have acquired
      // it between inspection and removal, allowing a refresh-token replay.
      if (Date.now() >= deadline)
        throw new Error(
          `Timed out waiting for credential access. If no Gauge process is running, remove ${path} and retry.`,
        );
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
