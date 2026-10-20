import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runConfig } from "@withgauge/api-schemas";
import { CliError } from "./client";
import {
  buildAgentRoster,
  parseAgentSpec,
  parseAgents,
  validateAssetRefs,
} from "./flags";

describe("parseAgentSpec", () => {
  it("parses a bare agent as the platform default (no pins)", () => {
    assert.deepEqual(parseAgentSpec("codex"), {
      agent: "CODEX_CLI",
      models: [],
    });
  });

  it("parses model pins after the colon", () => {
    assert.deepEqual(parseAgentSpec("codex:gpt-5.2,gpt-5.2-codex"), {
      agent: "CODEX_CLI",
      models: ["gpt-5.2", "gpt-5.2-codex"],
    });
  });

  it("accepts alias spellings and normalizes case", () => {
    assert.equal(parseAgentSpec("CLAUDE").agent, "CLAUDE_CODE");
    assert.equal(parseAgentSpec("open-code:qwen3").agent, "OPENCODE");
  });

  it("dedupes repeated model pins", () => {
    assert.deepEqual(parseAgentSpec("codex:m1,m1,m2").models, ["m1", "m2"]);
  });

  it("ignores empty segments between commas", () => {
    assert.deepEqual(parseAgentSpec("codex:m1,,m2,").models, ["m1", "m2"]);
  });

  it("rejects an unknown agent", () => {
    assert.throws(() => parseAgentSpec("copilot:m1"), CliError);
  });

  it("rejects cursor — never provisioned, would silently never run", () => {
    assert.throws(() => parseAgentSpec("cursor"), /not schedulable/);
  });

  it("rejects a colon with nothing after it", () => {
    assert.throws(() => parseAgentSpec("claude-code:"), CliError);
    assert.throws(() => parseAgentSpec("claude-code:,,"), CliError);
  });
});

describe("buildAgentRoster", () => {
  it("keeps one roster row per agent, merging repeated pins", () => {
    assert.deepEqual(
      buildAgentRoster(["claude-code:m1", "codex", "claude-code:m2"]),
      [
        { agent: "CLAUDE_CODE", models: ["m1", "m2"] },
        { agent: "CODEX_CLI", models: [] },
      ],
    );
  });
});

describe("validateAssetRefs — the strict name@label regime", () => {
  it("accepts well-formed refs and preserves order", () => {
    assert.deepEqual(
      validateAssetRefs("skill", ["acme-cli@1.2.0", "docs@2026-08-01"]),
      ["acme-cli@1.2.0", "docs@2026-08-01"],
    );
  });

  it("rejects a bare name — a search, not a reference", () => {
    assert.throws(() => validateAssetRefs("skill", ["foo"]), CliError);
  });

  it("rejects a missing name or label", () => {
    assert.throws(() => validateAssetRefs("mcp", ["@1.0"]), CliError);
    assert.throws(() => validateAssetRefs("mcp", ["foo@"]), CliError);
  });

  it("rejects two versions of one asset — refuses the whole nightly cycle at resolution", () => {
    assert.throws(
      () => validateAssetRefs("skill", ["a@1", "b@1", "a@2"]),
      /one version per asset/,
    );
  });

  it("allows the same label across different assets", () => {
    assert.deepEqual(validateAssetRefs("mcp", ["a@1", "b@1"]), ["a@1", "b@1"]);
  });
});

describe("parseAgents (csv filter)", () => {
  it("still parses the comma filter form", () => {
    assert.deepEqual(parseAgents("claude-code,codex,pi,opencode"), [
      "CLAUDE_CODE",
      "CODEX_CLI",
      "PI",
      "OPENCODE",
    ]);
  });
});

describe("run-count arithmetic (shared with the server)", () => {
  it("counts one unit per unpinned agent and one per pinned model", () => {
    assert.equal(
      runConfig.modelUnits([{ models: [] }, { models: ["m1", "m2"] }]),
      3,
    );
  });

  it("multiplies by samplesPerCycle and sums across presets", () => {
    const presets = [
      { agents: [{ models: ["m1", "m2"] }] },
      { agents: [{ models: [] }, { models: ["m3"] }] },
    ];
    assert.equal(runConfig.runsPerCycle(presets[0], 5), 10);
    assert.equal(runConfig.totalRunsPerCycle(presets, 5), 20);
  });
});
