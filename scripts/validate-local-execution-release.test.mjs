import assert from "node:assert/strict";
import { test } from "node:test";
import { validateLocalRelease } from "./validate-local-execution-release.mjs";

function fixture() {
  const dependencies = { "@withgauge/agent-adapters": "0.1.0" };
  return {
    tag: "local-execution-v0.1.0",
    manifest: {
      name: "@withgauge/local-execution", version: "0.1.0", private: false,
      repository: { url: "git+https://github.com/gauge-sh/gauge-cli.git", directory: "packages/local" },
      publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
      dependencies,
    },
    lock: { packages: { "packages/local": { name: "@withgauge/local-execution", version: "0.1.0", dependencies: { ...dependencies } } } },
    changelog: "# Changelog\n\n## Unreleased\n\n## 0.1.0 — 2026-10-15\n\n- Initial release.\n",
  };
}

test("accepts the public local-execution release independently of the CLI", () => {
  assert.doesNotThrow(() => validateLocalRelease(fixture()));
});
for (const [label, change, error] of [
  ["adapter tag", x => { x.tag = "agent-adapters-v0.1.0"; }, /tag/],
  ["wrong package", x => { x.manifest.name = "@withgauge/agent-adapters"; }, /package name/],
  ["wrong workspace", x => { x.manifest.repository.directory = "cli"; }, /workspace/],
  ["restricted access", x => { x.manifest.publishConfig.access = "restricted"; }, /public/],
  ["private flag", x => { x.manifest.private = true; }, /disabled/],
  ["stale lock", x => { x.lock.packages["packages/local"].version = "0.0.0"; }, /lockfile/],
  ["development dependency", x => { x.manifest.dependencies["@withgauge/agent-adapters"] = "file:../agent-adapters"; }, /exact published/],
  ["dependency range", x => { x.manifest.dependencies["@withgauge/agent-adapters"] = "^0.1.0"; }, /exact published/],
  ["unexpected dependency", x => { x.manifest.dependencies.extra = "1.0.0"; }, /one exact/],
  ["stale dependency lock", x => { x.lock.packages["packages/local"].dependencies["@withgauge/agent-adapters"] = "0.0.1"; }, /Lockfile dependency/],
]) {
  test(`rejects ${label}`, () => {
    const input = fixture(); change(input);
    assert.throws(() => validateLocalRelease(input), error);
  });
}
