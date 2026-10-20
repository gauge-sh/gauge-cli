import assert from "node:assert/strict";
import test from "node:test";
import { validateRuntimeManifest, validateRuntimeSource } from "./validate-runtime-release.mjs";
const manifest = { version: "0.1.0", repository: "ghcr.io/gauge-sh/gauge-runtime", digest: `sha256:${"a".repeat(64)}`, revision: "b".repeat(40), contract: "1", platforms: ["linux/amd64", "linux/arm64"] };
test("release requires a published digest and source revision while bootstrap accepts null", () => {
  validateRuntimeManifest(manifest);
  const unpublished = { ...manifest, digest: null, revision: null };
  validateRuntimeManifest(unpublished, { published: false, tag: "runtime-v0.1.0" });
  assert.throws(() => validateRuntimeManifest(unpublished), /immutable digest/);
  assert.throws(() => validateRuntimeManifest({ ...manifest, revision: null }), /source revision/);
});
test("release refuses mismatched tags, incorrect repositories and unqualified platforms", () => {
  assert.throws(() => validateRuntimeManifest(manifest, { tag: "runtime-v0.2.0" }), /tag/);
  assert.throws(() => validateRuntimeManifest({ ...manifest, repository: "ghcr.io/example/other-runtime" }), /public/);
  for (const platforms of [["linux/amd64"], ["linux/arm64"], ["linux/amd64", "linux/s390x"]])
    assert.throws(() => validateRuntimeManifest({ ...manifest, platforms }), /must include native/);
});


test("CLI source must match the pinned runtime source tree", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "runtime-release-source-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "maintenance.auto", "false");
  await mkdir(join(root, "packages/local/image"), { recursive: true });
  await writeFile(join(root, "packages/local/image/Dockerfile"), "FROM node:22\n");
  git("add", ".");
  git("-c", "user.name=Runtime test", "-c", "user.email=runtime@example.invalid", "commit", "-qm", "fixture");
  const pinned = { ...manifest, revision: git("rev-parse", "HEAD").trim() };
  validateRuntimeSource(pinned, root);
  assert.throws(
    () => validateRuntimeSource(manifest, root),
    /source revision is not available.*publish and qualify a new runtime version/,
  );
  await writeFile(join(root, "packages/local/image/Dockerfile"), "FROM node:24\n");
  assert.throws(() => validateRuntimeSource(pinned, root));
});
