import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { executionTargetsResponseSchema } from "@withgauge/api-schemas/executionTargets";
import {
  runEvalBodySchema,
  runVisibilityBodySchema,
} from "@withgauge/api-schemas/ownedConfigurations";
import { runDefinitionSubmissionSchema } from "@withgauge/api-schemas/runDefinitions";
import { ApiClient, CliError } from "../lib/client";
import { planLocal } from "../lib/localExecutor";
import { loadLocalRunDefinition } from "../lib/localRunInputs";
import { register } from "./run";

const agents = [{ agent: "ANTIGRAVITY", models: ["gemini-3.1-pro-preview"] }];

function program() {
  const command = new Command()
    .option("--hosted", "use hosted", true)
    .option("--org <org>")
    .option("-o, --output <format>");
  register(command);
  return command;
}

test("hosted saved eval and preference launches forward Antigravity overrides", async (t) => {
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(ApiClient.prototype, "post", async (path: string, body: unknown) => {
    calls.push({ path, body });
    return { runIds: ["run-1"], batchIds: ["batch-1"] };
  });
  t.mock.method(console, "log", () => {});
  for (const source of ["eval", "preference"]) {
    await program().parseAsync([
      "--org", "8c7f0e1a-1111-4222-8333-944455556666", "-o", "json", "run", `--${source}`, "saved-1",
      "--agent", "antigravity:gemini-3.1-pro-preview",
    ], { from: "user" });
  }
  assert.deepEqual(calls.map(({ path }) => path), [
    "/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/eval-sets/saved-1/run",
    "/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/visibility-prompts/saved-1/run",
  ]);
  assert.deepEqual(runEvalBodySchema.parse(calls[0].body).agents, agents);
  assert.deepEqual(runVisibilityBodySchema.parse(calls[1].body).agents, agents);
});

test("Antigravity cases load, preview and launch hosted, and refuse local execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gauge-antigravity-"));
  const previous = process.cwd();
  t.after(async () => {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "gauge.json"), JSON.stringify({ version: 2, orgId: "8c7f0e1a-1111-4222-8333-944455556666" }));
  await writeFile(join(root, "task.md"), [
    "---", "criteria:", "  - name: Works", "    rubric: Task completed",
    "config:", "  agents:", "    - agent: ANTIGRAVITY",
    "      models: [gemini-3.1-pro-preview]", "---", "Do the task.",
  ].join("\n"));
  process.chdir(root);

  const loaded = await loadLocalRunDefinition(["task.md"], [], root);
  t.after(loaded.cleanup);
  assert.deepEqual(loaded.definition.cases[0].config.agents, agents);
  await writeFile(join(root, "cases.json"), JSON.stringify({
    version: 2,
    cases: [{
      key: "task",
      prompt: "Do the task.",
      criteria: [{ name: "Works", rubric: "Task completed" }],
      config: { agents },
    }],
  }));
  await assert.rejects(planLocal(loaded.definition), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /ANTIGRAVITY cannot run locally/);
    assert.match(error.hint!, /--hosted/);
    return true;
  });

  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(ApiClient.prototype, "post", async (path: string, body: unknown) => {
    calls.push({ path, body });
    return { runRequestId: "request-1" };
  });
  t.mock.method(console, "log", () => {});
  for (const args of [
    ["--files", "task.md", "--dry-run"],
    ["--files", "task.md"],
    ["--apply", "cases.json", "--dry-run"],
    ["--apply", "cases.json"],
  ]) {
    await program().parseAsync([
      "-o", "json", "run", ...args,
    ], { from: "user" });
  }
  assert.deepEqual(calls.map(({ path }) => path), [
    "/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/run-definitions/plan",
    "/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/run-definitions/run",
    "/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/run-definitions/plan",
    "/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/run-definitions/run",
  ]);
  for (const call of calls) {
    const definition = runDefinitionSubmissionSchema.parse(call.body);
    assert.deepEqual(definition.cases[0].config.agents, agents);
  }
});

test("hosted execution targets accept Antigravity capabilities", () => {
  const response = executionTargetsResponseSchema.parse({ items: [{
    harness: "ANTIGRAVITY", harnessSlug: "antigravity", harnessLabel: "Antigravity",
    model: "gemini-3.1-pro-preview", modelLabel: "Gemini 3.1 Pro (Low)",
    providerSlug: "google", providerLabel: "Google",
    capabilities: { skills: true, mcp: true, connections: true, agentContext: false, resume: true },
  }] });
  assert.equal(response.items[0].harness, "ANTIGRAVITY");
});
