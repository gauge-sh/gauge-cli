import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { credentialKey, inspectLocalCredential, profileCredentialSources, readProfiles, resolveLocalProfile, setProfile, validateProfile, writeProfiles, type ProfileStore } from "./localProfiles";
import { planLocal, prepareLocal } from "./localExecutor";
import type { RunDefinitionSubmission } from "@withgauge/api-schemas/runDefinitions";

test("local credential profiles", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gauge-profiles-"));
  const original = { ...process.env };
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, "codex");
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { process.env = original; rmSync(root, { recursive: true, force: true }); });
  const empty: ProfileStore = { version: 1, profiles: {}, defaults: {} };
  const api = { agent: "CODEX_CLI", provider: "openai", auth: "api_key", env: "TEAM_OPENAI_KEY" };

  await t.test("CRUD stores references privately and requires explicit replacement", () => {
    process.env.TEAM_OPENAI_KEY = "secret-never-store";
    setProfile("work", api);
    const path = join(root, "gauge/local-profiles.json");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!readFileSync(path, "utf8").includes("secret-never-store"));
    assert.throws(() => setProfile("work", api), /--replace/);
    setProfile("work", api, true);
    assert.throws(() => setProfile("__proto__", api), /Profile names/);
    assert.throws(() => validateProfile({ ...api, env: "sk-secret-literal" }), /Invalid profile/);
    assert.throws(() => validateProfile({ ...api, provider: "anthropic" }), /requires provider openai/);
    const store = readProfiles();
    store.defaults.CODEX_CLI = "work";
    writeProfiles(store);
    assert.equal(resolveLocalProfile("CODEX_CLI", "custom-model").name, "work");
    assert.throws(() => resolveLocalProfile("PI", "openai/model", { profile: "work" }), /incompatible/);
  });
  await t.test("selected env variable overrides canonical key without leaking either secret", async () => {
    process.env.OPENAI_API_KEY = "wrong-key";
    const profile = resolveLocalProfile("CODEX_CLI", "custom-model");
    assert.equal(profileCredentialSources(profile).env.OPENAI_API_KEY, "secret-never-store");
    const result = await inspectLocalCredential("CODEX_CLI", "custom-model");
    assert.equal(result.ready, true);
    assert.equal(result.verification, "local");
    assert.ok(!JSON.stringify(result).includes("secret-never-store"));
    delete process.env.TEAM_OPENAI_KEY;
    assert.equal((await inspectLocalCredential("CODEX_CLI", "custom-model")).ready, false);
    process.env.TEAM_OPENAI_KEY = "secret-never-store";
    delete process.env.OPENAI_API_KEY;
  });
  await t.test("frozen selections survive default changes and damaged profile files", async () => {
    const profile = resolveLocalProfile("CODEX_CLI", "custom-model");
    const options = { credentialSelections: { [credentialKey("CODEX_CLI", "custom-model")]: profile } };
    writeFileSync(join(root, "gauge/local-profiles.json"), "broken secret-data");
    assert.deepEqual(resolveLocalProfile("CODEX_CLI", "custom-model", options), profile);
    assert.equal((await inspectLocalCredential("CODEX_CLI", "custom-model", options)).ready, true);
    assert.throws(() => readProfiles(), /Invalid local credential profile file/);
    assert.throws(() => resolveLocalProfile("CODEX_CLI", "other", options), /no saved login settings/);
    writeProfiles(empty);
  });
  await t.test("non-native providers select API auth and report missing credentials", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const result = await inspectLocalCredential("PI", "openrouter/some/model", {}, empty);
    assert.equal(result.profile?.auth, "api_key");
    assert.match(result.problem!, /OPENROUTER_API_KEY/);
  });
  await t.test("native login reports expiry and redacts malformed file errors", async () => {
    mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    const auth = join(process.env.CODEX_HOME!, "auth.json");
    writeFileSync(auth, "{secret-malformed-token}");
    const malformed = await inspectLocalCredential("CODEX_CLI", "model", {}, empty);
    assert.equal(malformed.ready, false);
    assert.ok(!JSON.stringify(malformed).includes("secret-malformed-token"));
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
    writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, refresh_token: "refresh-never-output" } }));
    const valid = await inspectLocalCredential("CODEX_CLI", "model", {}, empty);
    assert.equal(valid.ready, true);
    assert.equal(valid.expiresAt, new Date(exp * 1000).toISOString());
    assert.ok(!JSON.stringify(valid).includes(token));
    assert.ok(!JSON.stringify(valid).includes("refresh-never-output"));
    const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
    writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: expired } }));
    assert.match((await inspectLocalCredential("CODEX_CLI", "model", {}, empty)).problem!, /too soon/);
  });
  await t.test("preflight checks every actual provider/model before accepting a batch", async () => {
    setProfile("pi-login", { agent: "PI", provider: "openai-codex", auth: "access_token" });
    const store = readProfiles(); store.defaults.PI = "pi-login"; writeProfiles(store);
    const definition = { version: 2, source: { repoUrl: null, commit: null, digest: "sha256:test", verification: "LOCAL" }, resources: [], cases: [{ path: "task.md", prompt: "test", criteria: [], config: { agents: [{ agent: "PI", models: ["openai-codex/model-a", "anthropic/model-b"] }], sampleCount: 2 } }] } as RunDefinitionSubmission;
    const plan = await planLocal(definition);
    assert.equal(plan.expectedSessions, 4);
    assert.equal(plan.credentials.length, 2);
    assert.match(plan.credentials.find((c) => c.model === "anthropic/model-b")!.problem!, /incompatible/);
    await assert.rejects(prepareLocal(definition, [], join(root, "batch")), /anthropic\/model-b/);
  });
});
