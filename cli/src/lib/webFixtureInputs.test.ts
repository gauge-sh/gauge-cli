import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseWebFixtureInput, mergeWebFixtures } from "@withgauge/api-schemas/web-fixtures";
import { loadLocalRunDefinition } from "./localRunInputs";
import { freezeWebFixtures } from "./webFixtureInputs";
import { parseCaseSpec } from "./caseSpec";

const fixture = { version: 1, pages: [{ url: "https://example.com/docs#fragment", body: "fixture body" }], scopes: ["https://example.com/docs"] };

test("portable fixtures reject transformations, searches, conflicting routes, and invalid HTTP responses", () => {
  const parsed = parseWebFixtureInput(JSON.stringify(fixture));
  assert.deepEqual(parsed.pages[0], { url: "https://example.com/docs", status: 200, contentType: "text/html", body: "fixture body" });
  for (const invalid of [
    { ...fixture, transforms: {} }, { ...fixture, rewrites: {} },
    { ...fixture, searches: [{ query: "x", results: [] }] },
    { ...fixture, pages: [{ ...fixture.pages[0], status: 204 }] },
    { ...fixture, pages: [{ ...fixture.pages[0], contentType: "a\r\nb" }] },
    { ...fixture, pages: [{ ...fixture.pages[0], url: "file:///tmp/a" }] },
    { ...fixture, origins: [{ origin: "https://example.com", upstream: "https://preview.example.com" }] },
  ]) assert.throws(() => parseWebFixtureInput(JSON.stringify(invalid)));
  assert.throws(() => mergeWebFixtures([parsed, parsed]));
  assert.throws(() => mergeWebFixtures([parsed, parseWebFixtureInput(JSON.stringify({ version: 1, pages: [{ url: "https://example.com/docs/other", body: "conflict" }] }))]));
});

test("local and hosted use the same fixture upload; overrides are frozen and case selection is respected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gauge-fixture-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "gauge-cases"));
  await writeFile(join(root, "gauge.json"), JSON.stringify({ version: 2, inputs: { docs: { type: "web-fixture", path: "docs.json" } } }));
  await writeFile(join(root, "docs.json"), JSON.stringify(fixture));
  await writeFile(join(root, "override.json"), JSON.stringify({ ...fixture, pages: [{ ...fixture.pages[0], body: "override" }] }));
  await writeFile(join(root, "gauge-cases/a.md"), "---\ncriteria:\n  - name: Works\n    rubric: Task completed\nconfig:\n  agents:\n    - agent: CODEX_CLI\n      models: []\n  inputs: [docs]\n---\nRead the docs.\n");
  const local = await loadLocalRunDefinition([], ["docs=override.json"], root, { local: true });
  const hosted = await loadLocalRunDefinition([], ["docs=override.json"], root);
  t.after(local.cleanup); t.after(hosted.cleanup);
  assert.deepEqual(local.definition, hosted.definition);
  assert.deepEqual(local.definition.resources[0].use, { type: "web-fixture", path: "override.json" });
  assert.equal(local.webFixtures["gauge-cases/a.md"].fixture.pages[0].body, "override");
  await writeFile(join(root, "override.json"), "changed after selection");
  assert.deepEqual(await freezeWebFixtures(local.definition, local.uploads), local.webFixtures);
  const unselected = { ...local.definition, cases: local.definition.cases.map((c) => ({ ...c, config: { ...c.config, inputs: [] } })) };
  assert.deepEqual(await freezeWebFixtures(unselected, local.uploads), {});
  const bytes = await readFile(local.uploads[0].path);
  await writeFile(local.uploads[0].path, Buffer.concat([bytes, Buffer.from("tampered")]));
  await assert.rejects(freezeWebFixtures(local.definition, local.uploads), /digest mismatch/);
});

test("canonical organization selection survives fixture loading from files and an inline case spec", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gauge-canonical-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const orgId = "8c7f0e1a-1111-4222-8333-944455556666";
  await mkdir(join(root, "gauge-cases"));
  await writeFile(join(root, "gauge.json"), JSON.stringify({
    version: 2, orgId, inputs: { docs: { type: "web-fixture", path: "docs.json" } },
  }));
  await writeFile(join(root, "docs.json"), JSON.stringify(fixture));
  await writeFile(join(root, "gauge-cases/a.md"), "---\ncriteria:\n  - name: Works\n    rubric: Task completed\nconfig:\n  agents:\n    - agent: CODEX_CLI\n      models: []\n  inputs: [docs]\n---\nRead the docs.\n");
  const spec = parseCaseSpec({
    version: 2,
    cases: [{
      key: "inline",
      prompt: "Read the docs.",
      criteria: [{ name: "Works", rubric: "Task completed" }],
      config: { agents: [{ agent: "CODEX_CLI" }], inputs: ["docs"] },
    }],
  });
  for (const options of [{}, { spec }]) {
    const loaded = await loadLocalRunDefinition([], [], root, options);
    t.after(loaded.cleanup);
    assert.equal(loaded.org, orgId);
    assert.equal(Object.values(loaded.webFixtures)[0]?.fixture.pages[0].body, "fixture body");
  }
});
