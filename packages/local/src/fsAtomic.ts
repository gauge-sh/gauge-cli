import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

function tempPath(path: string): string {
  return `${path}.tmp-${process.pid}-${randomUUID()}`;
}

async function writeSynced(path: string, data: string, mode: number) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeFileAtomic(
  path: string,
  data: string,
  mode = 0o644,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  try {
    await writeSynced(tmp, data, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  return writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
