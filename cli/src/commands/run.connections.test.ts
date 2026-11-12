import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
test("local connection flags select credentials without exposing values in dry-run output", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gauge-cli-connection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".gauge"));
  writeFileSync(join(root, "gauge.json"), JSON.stringify({ version: 2, inputs: {} }));
  writeFileSync(join(root, ".gauge", "connections.yaml"), `version: 1\nconnections:\n  - name: test-api\n    origin: https://api.example.test\n    header: X-Api-Key\n    env: GAUGE_TEST_CONNECTION_VALUE\n`);
  const secret = "fixture-secret-must-not-appear";
  const invoke = (flags: string[], value = secret) => spawnSync(process.execPath, [cli, "run", "Inspect this API", ...flags, "--dry-run", "-o", "json"], {
    cwd: root, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, GAUGE_TELEMETRY_DISABLED: "1", XDG_CONFIG_HOME: root, GAUGE_TEST_CONNECTION_VALUE: value },
  });
  const result = invoke(["--local", "--connection", "test-api"]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.connections, [{ name: "test-api", origin: "https://api.example.test", header: "X-Api-Key", env: "GAUGE_TEST_CONNECTION_VALUE", ready: true }]);
  assert.ok(plan.gateway, "connection-only runs need a gateway");
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  const missing = invoke(["--local", "--connection", "test-api"], "");
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).connections[0].ready, false);
  assert.match(missing.stdout, /missing or empty/);
  const unknown = invoke(["--local", "--connection", "unknown"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr + unknown.stdout, /not configured/);
  const hosted = invoke(["--hosted", "--connection", "test-api"]);
  assert.notEqual(hosted.status, 0);
  assert.match(hosted.stderr + hosted.stdout, /only to local runs/);
  const unused = invoke(["--local", "--connections-file", join(root, "missing.yaml")]);
  assert.equal(unused.status, 0, unused.stderr);
  assert.deepEqual(JSON.parse(unused.stdout).connections, []);
});
