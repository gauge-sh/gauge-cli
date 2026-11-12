import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunDefinitionSubmission } from "@withgauge/api-schemas/runDefinitions";
import { connectionsForCase, gatewayForCase } from "./localExecutor";
import { assertLocalCapabilities } from "./localCapabilities";
import { inspectLocalConnections, loadConnectionPlan, parseLocalConnections, resolveLocalConnections } from "./localConnections";

const entry = { name: "supabase", origin: "https://PROJECT.supabase.co:443/", header: "Authorization", env: "SUPABASE_AUTH" };
const yaml = (connections: unknown = [entry]) => JSON.stringify({ version: 1, connections });
const definition = (names: string[] = ["supabase"]): RunDefinitionSubmission => ({
  version: 2, source: { repoUrl: null, commit: null, digest: "sha256:test", verification: "LOCAL" }, resources: [], cases: [{ path: "case", prompt: "test", config: { agents: [{ agent: "CODEX_CLI", models: [] }], connectionIds: names } }],
});

test("local registry stores names and references; resolution uses the complete header value", () => {
  const connections = parseLocalConnections(yaml());
  assert.equal(connections[0].origin, "https://project.supabase.co");
  assert.equal(JSON.stringify(connections).includes("value"), false);
  const resolved = resolveLocalConnections(connections, { SUPABASE_AUTH: "Bearer fake-token" });
  assert.equal(resolved[0].value, "Bearer fake-token");
  assert.equal(resolved[0].header, "Authorization");
  assert.doesNotThrow(() => assertLocalCapabilities({ connectionIds: ["supabase"] }));
});

test("registry rejects secrets, ambiguous destinations, duplicate declarations, and unsafe headers", () => {
  const invalid = [
    [{ ...entry, value: "NEVER-LOG-THIS" }],
    [{ ...entry, origin: "http://example.com" }],
    [{ ...entry, origin: "https://*.example.com" }],
    [{ ...entry, origin: "https://example.com/path" }],
    [{ ...entry, origin: "https://example.com?token=NEVER-LOG-THIS" }],
    [{ ...entry, origin: "https://example.com:8443" }],
    [{ ...entry, header: "Host" }],
    [{ ...entry, header: "Connection" }],
    [{ ...entry, env: "${TOKEN}" }],
    [entry, entry],
  ];
  for (const registry of invalid) assert.throws(() => parseLocalConnections(yaml(registry)), (error: Error) => !error.message.includes("NEVER-LOG-THIS"), JSON.stringify(registry));
  for (const source of ["version: 1\nconnections: [NEVER-LOG-THIS", "version: 1\nversion: 1\nconnections: []", "version: 1\nconnections: &a [*a]"])
    assert.throws(() => parseLocalConnections(source), (error: Error) => !error.message.includes("NEVER-LOG-THIS"));
});

test("missing and invalid secrets fail without including values in diagnostics or previews", () => {
  const connections = parseLocalConnections(yaml());
  assert.throws(() => resolveLocalConnections(connections, {}), /SUPABASE_AUTH is missing or empty/);
  assert.throws(() => resolveLocalConnections(connections, { SUPABASE_AUTH: "NEVER-LOG-THIS\r\nheader: value" }), (error: Error) => !error.message.includes("NEVER-LOG-THIS"));
  const old = process.env.SUPABASE_AUTH;
  try {
    process.env.SUPABASE_AUTH = "NEVER-LOG-THIS";
    const preview = inspectLocalConnections({ case: connections });
    assert.equal(preview[0].ready, true);
    assert.equal(JSON.stringify(preview).includes("NEVER-LOG-THIS"), false);
  } finally {
    if (old === undefined) delete process.env.SUPABASE_AUTH; else process.env.SUPABASE_AUTH = old;
  }
});

test("selects only requested registry entries per case and needs no file without selections", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gauge-connections-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "connections.yaml");
  assert.deepEqual(await loadConnectionPlan(definition([]), path), {});
  await assert.rejects(loadConnectionPlan(definition(), path), /Could not read/);
  await writeFile(path, yaml([entry, { ...entry, name: "unused", origin: "https://unused.example", env: "UNUSED_AUTH" }]));
  const plan = await loadConnectionPlan(definition(), path);
  assert.deepEqual(plan.case.map((c) => c.name), ["supabase"]);
  await assert.rejects(loadConnectionPlan(definition(["unknown"]), path), /not configured/);
  await assert.rejects(loadConnectionPlan(definition(["supabase", "supabase"]), path), /duplicate/);
  await writeFile(path, yaml([entry, { ...entry, name: "other-account", env: "OTHER_AUTH" }]));
  assert.equal((await loadConnectionPlan(definition(), path)).case.length, 1);
  await assert.rejects(loadConnectionPlan(definition(["supabase", "other-account"]), path), /conflict/);
});

test("connection-only cases get a gateway and empty fixture; unrelated cases get none", () => {
  const runtime = { imageId: "sha256:gateway" } as Parameters<typeof gatewayForCase>[0];
  assert.equal(gatewayForCase(runtime, undefined), undefined);
  const selected = parseLocalConnections(yaml());
  const gateway = gatewayForCase(runtime, undefined, selected);
  assert.equal(gateway?.image, "sha256:gateway");
  assert.deepEqual(gateway?.fixture, { version: 1, pages: [], searches: [] });
  assert.match(gateway!.digest, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => gatewayForCase(undefined, undefined, selected), /require a gateway/);
});

test("case names cannot inherit connections from Object.prototype", () => {
  for (const path of ["constructor", "__proto__", "toString"])
    assert.deepEqual(connectionsForCase({}, path), []);
});
