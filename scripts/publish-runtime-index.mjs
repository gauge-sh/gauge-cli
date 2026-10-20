import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeTagExists } from "./runtime-tag.mjs";
import { validateRuntimeManifest } from "./validate-runtime-release.mjs";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export function validateCandidates(manifest, candidates, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/, "Runtime source revision is required");
  assert.deepEqual(candidates.map(item => item.platform).sort(), [...manifest.platforms].sort(), "One qualified image per runtime platform is required");
  for (const item of candidates) {
    assert.match(item.digest, digestPattern);
    assert.equal(item.revision, revision, "All native images must come from the release commit");
  }
}

export function validateRuntimeIndex(manifest, index, candidates, revision) {
  validateCandidates(manifest, candidates, revision);
  assert.match(index.digest, digestPattern, "Pin the index digest, not a platform image digest");
  assert.ok(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"].includes(index.mediaType), "Release tag must reference a multi-platform image index");
  const expected = candidates.map(item => `${item.platform}@${item.digest}`).sort();
  const actual = (index.manifests ?? []).map(item => `${item.platform?.os}/${item.platform?.architecture}@${item.digest}`).sort();
  assert.deepEqual(actual, expected, "Existing runtime version differs from the qualified images; bump the version instead of replacing it");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = new URL("../cli/runtime-manifest.json", import.meta.url);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  validateRuntimeManifest(manifest, { published: false });
  const revision = process.env.GITHUB_SHA;
  const candidates = await Promise.all(manifest.platforms.map(platform =>
    readFile(join(process.argv[2], `${platform.split("/")[1]}.json`), "utf8").then(JSON.parse)));
  validateCandidates(manifest, candidates, revision);
  const image = `${manifest.repository}:${manifest.version}`;
  const exists = await runtimeTagExists(manifest, { actor: process.env.GITHUB_ACTOR, token: process.env.GHCR_TOKEN });
  if (!exists) {
    execFileSync("docker", ["buildx", "imagetools", "create", "--tag", image,
      "--annotation", `index:org.opencontainers.image.revision=${revision}`,
      "--annotation", "index:org.opencontainers.image.source=https://github.com/gauge-sh/gauge-cli",
      ...candidates.map(item => `${manifest.repository}@${item.digest}`)], { stdio: "inherit" });
  }
  const index = JSON.parse(execFileSync("docker", ["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"], { encoding: "utf8" }));
  validateRuntimeIndex(manifest, index, candidates, revision);
  const pinned = { ...manifest, digest: index.digest, revision };
  validateRuntimeManifest(pinned);
  await writeFile(path, `${JSON.stringify(pinned, null, 2)}\n`);
}
