import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliError } from "./client";
import {
  hasRunSettingsFlags,
  type OwnedConfigEditOpts,
  ownedConfigFromOpts,
  ownedConfigPatchFromOpts,
  type RunSettingsCreateOpts,
  runOverridesFromOpts,
  runSettingsFromOpts,
  runSettingsPatchFromOpts,
} from "./ownedConfig";

const NO_EDITS: OwnedConfigEditOpts = {
  agent: [],
  skill: [],
  mcp: [],
  connection: [],
};

describe("ownedConfigFromOpts", () => {
  it("sends a complete configuration, nulling what was not passed", () => {
    assert.deepEqual(
      ownedConfigFromOpts({
        agent: ["claude-code:opus-4-8"],
        skill: [],
        mcp: [],
        connection: [],
        cadence: "weekly",
        samples: "3",
      }),
      {
        repoUrl: null,
        repoRef: null,
        profileId: null,
        agents: [{ agent: "CLAUDE_CODE", models: ["opus-4-8"] }],
        skillRefs: [],
        mcpRefs: [],
        connectionIds: [],
        cadence: "WEEKLY",
        sampleCount: 3,
      },
    );
  });

  it("refuses a roster-less configuration and a ref without a repo", () => {
    const base = {
      agent: [] as string[],
      skill: [],
      mcp: [],
      connection: [],
      cadence: "none",
      samples: "1",
    };
    assert.throws(() => ownedConfigFromOpts(base), CliError);
    assert.throws(
      () => ownedConfigFromOpts({ ...base, agent: ["codex"], ref: "main" }),
      /--ref requires --repo/,
    );
  });
});

describe("ownedConfigPatchFromOpts", () => {
  it("sends nothing when nothing was passed", () => {
    assert.deepEqual(ownedConfigPatchFromOpts(NO_EDITS), {});
  });

  it("keeps an existing ref pin when only --repo moves", () => {
    assert.deepEqual(
      ownedConfigPatchFromOpts({
        ...NO_EDITS,
        repo: "https://github.com/acme/api",
      }),
      { repoUrl: "https://github.com/acme/api" },
    );
  });

  it("--clear-repo drops the ref pin with the repo", () => {
    assert.deepEqual(
      ownedConfigPatchFromOpts({ ...NO_EDITS, clearRepo: true }),
      {
        repoUrl: null,
        repoRef: null,
      },
    );
  });

  it("distinguishes an emptied asset set from an untouched one", () => {
    assert.deepEqual(
      ownedConfigPatchFromOpts({ ...NO_EDITS, clearSkills: true }),
      { skillRefs: [] },
    );
    assert.equal("skillRefs" in ownedConfigPatchFromOpts(NO_EDITS), false);
  });

  it("refuses a set flag paired with its --clear- counterpart", () => {
    for (const opts of [
      { ...NO_EDITS, repo: "https://github.com/acme/api", clearRepo: true },
      { ...NO_EDITS, skill: ["a@1"], clearSkills: true },
    ])
      assert.throws(() => ownedConfigPatchFromOpts(opts), CliError);
  });

  it("rejects an out-of-range sample count and an unknown cadence", () => {
    assert.throws(
      () => ownedConfigPatchFromOpts({ ...NO_EDITS, samples: "0" }),
      /1 to 50/,
    );
    assert.throws(
      () => ownedConfigPatchFromOpts({ ...NO_EDITS, cadence: "hourly" }),
      /invalid cadence/,
    );
  });

  it("normalizes cadence case so `--cadence Daily` is not a silent no-op", () => {
    assert.deepEqual(
      ownedConfigPatchFromOpts({ ...NO_EDITS, cadence: "Daily" }),
      {
        cadence: "DAILY",
      },
    );
  });
});

const NO_SETTINGS: RunSettingsCreateOpts = {
  agent: [],
  skill: [],
  mcp: [],
  connection: [],
  cadence: "none",
  samples: "1",
};

describe("run settings (a preference prompt owns one set)", () => {
  it("hasRunSettingsFlags is false when only the flag defaults are present", () => {
    assert.equal(hasRunSettingsFlags(NO_SETTINGS), false);
    for (const opts of [
      { ...NO_SETTINGS, connection: ["c_1"] },
      { ...NO_SETTINGS, samples: "3" },
    ])
      assert.equal(hasRunSettingsFlags(opts), true);
  });

  it("carries no repo, ref, or persona — those belong to a scenario", () => {
    const settings = runSettingsFromOpts({
      ...NO_SETTINGS,
      agent: ["claude-code:opus-4-8"],
      cadence: "weekly",
      samples: "3",
    });
    assert.deepEqual(settings, {
      agents: [{ agent: "CLAUDE_CODE", models: ["opus-4-8"] }],
      skillRefs: [],
      mcpRefs: [],
      connectionIds: [],
      cadence: "WEEKLY",
      sampleCount: 3,
    });
  });

  it("omits the roster when no --agent was passed so the server default applies", () => {
    const settings = runSettingsFromOpts({ ...NO_SETTINGS, cadence: "daily" });
    assert.equal("agents" in settings, false);
    assert.equal(settings.cadence, "DAILY");
  });

  it("patches only what was passed and never a repo or persona key", () => {
    assert.deepEqual(
      runSettingsPatchFromOpts({
        ...NO_SETTINGS,
        cadence: undefined,
        samples: undefined,
      }),
      {},
    );
    const patch = runSettingsPatchFromOpts({
      ...NO_SETTINGS,
      cadence: "monthly",
      samples: undefined,
      clearSkills: true,
    });
    assert.deepEqual(patch, { cadence: "MONTHLY", skillRefs: [] });
  });
});

describe("runOverridesFromOpts", () => {
  it("sends nothing without flags", () => {
    assert.deepEqual(runOverridesFromOpts({ agent: [] }), {});
  });

  it("builds a roster and sample count for one launch", () => {
    assert.deepEqual(
      runOverridesFromOpts({ agent: ["claude-code:sonnet"], samples: "3" }),
      {
        agents: [{ agent: "CLAUDE_CODE", models: ["sonnet"] }],
        sampleCount: 3,
      },
    );
  });

  it("rejects an out-of-range sample count", () => {
    assert.throws(
      () => runOverridesFromOpts({ agent: [], samples: "0" }),
      CliError,
    );
  });
});
