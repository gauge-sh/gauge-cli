import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function validateRuntimeManifest(manifest, { published = true, tag } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Runtime version must be a stable semantic version");
  if (manifest.repository !== "ghcr.io/gauge-sh/gauge-runtime") throw new Error("Runtime must use the public Gauge repository");
  if (manifest.contract !== "1") throw new Error("Unsupported runtime contract");
  if (JSON.stringify(manifest.platforms) !== JSON.stringify(["linux/amd64", "linux/arm64"])) throw new Error("Runtime releases must include native linux/amd64 and linux/arm64 images");
  if (tag && tag !== `runtime-v${manifest.version}`) throw new Error("Runtime release tag does not match manifest version");
  if (published && !/^sha256:[a-f0-9]{64}$/.test(manifest.digest ?? "")) throw new Error("Publish and anonymously qualify the runtime, then commit its immutable digest before releasing the CLI");
  if (published && !/^[a-f0-9]{40}$/.test(manifest.revision ?? "")) throw new Error("Pin the runtime source revision alongside its published digest");
}

export function validateRuntimeSource(manifest, repositoryRoot) {
  try {
    execFileSync("git", ["cat-file", "-e", `${manifest.revision}^{commit}`], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
  } catch (cause) {
    throw new Error(
      "The pinned runtime source revision is not available in this checkout. Use a full clone with that revision, or publish and qualify a new runtime version from this repository, then commit its manifest before releasing the CLI.",
      { cause },
    );
  }
  execFileSync("git", ["diff", "--exit-code", manifest.revision, "--", "packages/local/image"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(await readFile(new URL("../cli/runtime-manifest.json", import.meta.url), "utf8"));
  const tag = process.argv.find((arg) => arg.startsWith("runtime-v"));
  validateRuntimeManifest(manifest, { published: !process.argv.includes("--bootstrap"), tag });
  console.log(`Runtime metadata is consistent for ${manifest.version}`);
}
