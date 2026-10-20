import assert from "node:assert/strict";
import test from "node:test";
import { inspectLocalRuntime, RUNTIME_IMAGE, type DockerRead } from "./localRuntime";
const details = { Id: `sha256:${"a".repeat(64)}`, Os: "linux", Architecture: "amd64", RepoDigests: ["ghcr.io/gauge-sh/gauge-runtime@sha256:digest"], Config: { Labels: { "sh.gauge.contract": "1" } } };
function docker(image = details, server = { Os: "linux", Arch: "amd64" }): DockerRead {
  return (args) => JSON.stringify(args[0] === "version" ? server : [image]);
}
test("inspection resolves local identity with no pull or network request", () => {
  const calls: string[][] = [];
  const result = inspectLocalRuntime(undefined, (args) => { calls.push(args); return docker()(args); });
  assert.equal(result.ready, true);
  assert.equal(result.imageId, details.Id);
  assert.equal(result.reference, RUNTIME_IMAGE);
  assert.equal(result.platform, "linux/amd64");
  assert.deepEqual(calls, [["version", "--format", "{{json .Server}}"], ["image", "inspect", RUNTIME_IMAGE]]);
});
test("inspection distinguishes Docker unavailable and missing image with supported remedy", () => {
  assert.equal(inspectLocalRuntime(undefined, () => { throw new Error(); }).problem?.code, "docker_unavailable");
  const missing = inspectLocalRuntime(undefined, (args) => { if (args[0] === "image") throw new Error(); return docker()(args); });
  assert.equal(missing.problem?.code, "image_missing");
  assert.equal(missing.problem?.hint, "Run: gauge local runtime pull");
});
test("inspection accepts native ARM64 Docker, including Docker Desktop on Apple Silicon", () => {
  const result = inspectLocalRuntime("custom", docker({ ...details, Architecture: "arm64" }, { Os: "linux", Arch: "arm64" }));
  assert.equal(result.ready, true);
  assert.equal(result.platform, "linux/arm64");
});
test("inspection rejects missing contract, architecture mismatch, and non-Linux containers", () => {
  assert.equal(inspectLocalRuntime("custom", docker({ ...details, Config: { Labels: { "sh.gauge.contract": "2" } } })).problem?.code, "contract_unsupported");
  assert.equal(inspectLocalRuntime("custom", docker(details, { Os: "linux", Arch: "arm64" })).problem?.code, "platform_unsupported");
  assert.equal(inspectLocalRuntime("custom", docker({ ...details, Architecture: "arm64" })).problem?.code, "platform_unsupported");
  assert.equal(inspectLocalRuntime("custom", docker(details, { Os: "windows", Arch: "amd64" })).problem?.code, "platform_unsupported");
  assert.equal(inspectLocalRuntime("custom", docker(details, { Os: "linux", Arch: "s390x" })).problem?.code, "platform_unsupported");
});
