import { cp, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

async function directoryExists(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error(`Expected a directory: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function preserveWorkspace(directory: string, runtime: string): Promise<string | undefined> {
  const artifact = "recovered-workspace";
  const destination = join(directory, artifact);
  if (await directoryExists(destination)) return artifact;
  const source = join(runtime, "workspace", "workspace");
  if (!await directoryExists(source)) return undefined;
  try { await rename(source, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const staging = await mkdtemp(join(directory, ".workspace-"));
    try {
      await cp(source, join(staging, "repo"), { recursive: true, dereference: false, verbatimSymlinks: true });
      await rename(join(staging, "repo"), destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  return artifact;
}
