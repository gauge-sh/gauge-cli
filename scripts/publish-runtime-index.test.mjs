import assert from "node:assert/strict";
import test from "node:test";
import { validateCandidates, validateRuntimeIndex } from "./publish-runtime-index.mjs";

const revision = "a".repeat(40);
const manifest = { platforms: ["linux/amd64", "linux/arm64"] };
const candidates = manifest.platforms.map((platform, i) => ({ platform, revision, digest: `sha256:${String(i + 1).repeat(64)}` }));
const index = {
  mediaType: "application/vnd.oci.image.index.v1+json",
  digest: `sha256:${"f".repeat(64)}`,
  manifests: candidates.map(({ platform, digest }) => ({ platform: { os: "linux", architecture: platform.split("/")[1] }, digest })),
};

test("one index pins both native images, independent of descriptor order", () => {
  validateRuntimeIndex(manifest, index, candidates, revision);
  validateRuntimeIndex(manifest, { ...index, manifests: [...index.manifests].reverse() }, candidates, revision);
});
test("missing, duplicate, or wrong-source native builds cannot be published", () => {
  assert.throws(() => validateCandidates(manifest, candidates.slice(0, 1), revision), /One qualified image/);
  assert.throws(() => validateCandidates(manifest, [candidates[0], candidates[0]], revision), /One qualified image/);
  assert.throws(() => validateCandidates(manifest, [candidates[0], { ...candidates[1], revision: "b".repeat(40) }], revision), /release commit/);
});
test("retry refuses a different or incomplete existing release instead of overwriting it", () => {
  assert.throws(() => validateRuntimeIndex(manifest, { ...index, manifests: index.manifests.slice(0, 1) }, candidates, revision), /bump the version/);
  assert.throws(() => validateRuntimeIndex(manifest, { ...index, manifests: [index.manifests[0], { ...index.manifests[1], digest: `sha256:${"3".repeat(64)}` }] }, candidates, revision), /bump the version/);
  assert.throws(() => validateRuntimeIndex(manifest, { ...index, mediaType: "application/vnd.oci.image.manifest.v1+json" }, candidates, revision), /multi-platform/);
});
