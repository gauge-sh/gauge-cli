import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config";

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export type TelemetryStatus = {
  enabled: boolean;
  source: "environment" | "preference" | "default" | "unavailable";
};

export async function telemetryStatus(
  directory = configDir(),
): Promise<TelemetryStatus> {
  if (process.env.GAUGE_TELEMETRY_DISABLED === "1")
    return { enabled: false, source: "environment" };
  try {
    const value: unknown = JSON.parse(
      await readFile(join(directory, "telemetry.json"), "utf8"),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("enabled" in value) ||
      typeof value.enabled !== "boolean"
    )
      return { enabled: false, source: "unavailable" };
    return { enabled: value.enabled, source: "preference" };
  } catch (error) {
    return hasCode(error, "ENOENT")
      ? { enabled: true, source: "default" }
      : { enabled: false, source: "unavailable" };
  }
}

export async function setTelemetryEnabled(
  enabled: boolean,
  directory = configDir(),
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.telemetry-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ enabled })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(directory, "telemetry.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function installationId(directory = configDir()): Promise<string> {
  const path = join(directory, "telemetry-id");
  try {
    return validId(await readFile(path, "utf8"));
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const temporary = join(directory, `.telemetry-id-${id}.tmp`);
  try {
    await writeFile(temporary, `${id}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    return validId(await readFile(path, "utf8"));
  } finally {
    await rm(temporary, { force: true });
  }
}

function validId(raw: string): string {
  const id = raw.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new Error("Invalid telemetry identity");
  return id;
}
