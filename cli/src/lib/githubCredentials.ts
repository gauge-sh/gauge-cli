import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { configDir } from "./config";

export function githubCredentialsPath(): string {
  return join(configDir(), "github-credentials");
}

export function resolveGithubToken(): string | null {
  const token = process.env.GAUGE_GITHUB_TOKEN?.trim();
  if (token) return token;
  try {
    return readFileSync(githubCredentialsPath(), "utf8").trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function saveGithubToken(token: string): void {
  const value = token.trim();
  if (!value || /\s/.test(value)) throw new Error("Expected a single nonempty GitHub token");
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const temporary = `${githubCredentialsPath()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, githubCredentialsPath());
  } finally {
    rmSync(temporary, { force: true });
  }
}
