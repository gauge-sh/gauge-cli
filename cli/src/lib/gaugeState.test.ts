import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { readGaugeState, findWorkspace } from "./gaugeState";
function workspace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "gauge-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "gauge.json"), '{"version":2,"inputs":{}}');
  return root;
}
test("backend precedence is flag, private workspace, user, then local, independent of login", (t) => {
  const root = workspace(t);
  assert.equal(
    readGaugeState({}, root, { signedIn: true, orgId: "acme" }).mode,
    "local",
  );
  assert.equal(
    readGaugeState({}, root, { signedIn: false, backend: "hosted" }).source,
    "user",
  );
  mkdirSync(join(root, ".gauge"));
  writeFileSync(
    join(root, ".gauge/config.json"),
    '{"version":1,"backend":"local"}',
  );
  assert.equal(
    readGaugeState({}, root, { signedIn: true, backend: "hosted" }).source,
    "workspace",
  );
  assert.equal(
    readGaugeState({ hosted: true }, root, { signedIn: false }).mode,
    "hosted",
  );
});
test("nearest parent manifest defines the workspace without Git", (t) => {
  const root = workspace(t);
  const child = join(root, "src");
  mkdirSync(child);
  assert.equal(findWorkspace(child), root);
  writeFileSync(join(child, "gauge.json"), "{}");
  assert.equal(findWorkspace(child), child);
});
test("malformed private config is reported instead of silently changing backend", (t) => {
  const root = workspace(t);
  mkdirSync(join(root, ".gauge"));
  writeFileSync(
    join(root, ".gauge/config.json"),
    '{"version":1,"backend":"cloud"}',
  );
  assert.throws(
    () => readGaugeState({}, root, { signedIn: false }),
    /Invalid backend/,
  );
});
