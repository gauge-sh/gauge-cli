import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function validateRuntimeManifest(manifest, { published = true, tag, gateway = false } = {}) {
  const component = gateway ? "gateway" : "runtime";
  const label = gateway ? "Gateway" : "Runtime";
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`${label} version must be a stable semantic version`);
  if (manifest.repository !== `ghcr.io/gauge-sh/gauge-${component}`) throw new Error(`${label} must use the public Gauge repository`);
  if (manifest.contract !== (gateway ? "gateway-1" : "1")) throw new Error(`Unsupported ${component} contract`);
  if (JSON.stringify(manifest.platforms) !== JSON.stringify(["linux/amd64", "linux/arm64"])) throw new Error(`${label} releases must include native linux/amd64 and linux/arm64 images`);
  if (tag && tag !== `${component}-v${manifest.version}`) throw new Error(`${label} release tag does not match manifest version`);
  if (published && !/^sha256:[a-f0-9]{64}$/.test(manifest.digest ?? "")) throw new Error(`Publish and anonymously qualify the ${component}, then commit its immutable digest before releasing the CLI`);
  if (published && !/^[a-f0-9]{40}$/.test(manifest.revision ?? "")) throw new Error(`Pin the ${component} source revision alongside its published digest`);
}

export function validateRuntimeSource(manifest, repositoryRoot) {
  const component = manifest.repository.endsWith("/gauge-gateway") ? "gateway" : "runtime";
  try {
    execFileSync("git", ["cat-file", "-e", `${manifest.revision}^{commit}`], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
  } catch (cause) {
    throw new Error(
      `The pinned ${component} source revision is not available in this checkout. Use a full clone with that revision, or publish and qualify a new ${component} version from this repository, then commit its manifest before releasing the CLI.`,
      { cause },
    );
  }
  execFileSync("git", ["diff", "--exit-code", manifest.revision, "--", component === "gateway" ? "packages/local/gateway" : "packages/local/image"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const gateway = process.argv.includes("--gateway");
  const component = gateway ? "gateway" : "runtime";
  const manifest = JSON.parse(await readFile(new URL(`../cli/${component}-manifest.json`, import.meta.url), "utf8"));
  const tag = process.argv.find((arg) => arg.startsWith(`${component}-v`));
  validateRuntimeManifest(manifest, { published: !process.argv.includes("--bootstrap"), tag, gateway });
  console.log(`${gateway ? "Gateway" : "Runtime"} metadata is consistent for ${manifest.version}`);
}
