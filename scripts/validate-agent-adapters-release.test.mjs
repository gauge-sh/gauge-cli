import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRelease } from "./validate-agent-adapters-release.mjs";

function fixture() {
  return {
    tag: "agent-adapters-v0.1.0",
    manifest: {
      name: "@withgauge/chosen-name",
      version: "0.1.0",
      private: false,
      repository: {
        url: "git+https://github.com/gauge-sh/gauge-cli.git",
        directory: "packages/agent-adapters",
      },
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
      },
    },
    lock: {
      packages: {
        "packages/agent-adapters": {
          name: "@withgauge/chosen-name",
          version: "0.1.0",
        },
      },
    },
    changelog:
      "# Changelog\n\n## Unreleased\n\n## 0.1.0 — 2026-10-15\n\n- Initial release.\n",
  };
}

test("accepts a consistent release using the chosen package name", () => {
  assert.doesNotThrow(() => validateRelease(fixture()));
});

const cases = [
  [
    "private preparation",
    (x) => {
      x.manifest.private = true;
    },
    /disabled/,
  ],
  [
    "missing release opt-in",
    (x) => {
      delete x.manifest.private;
    },
    /disabled/,
  ],
  [
    "unscoped name",
    (x) => {
      x.manifest.name = "chosen-name";
    },
    /chosen/,
  ],
  [
    "placeholder version",
    (x) => {
      x.manifest.version = "0.0.0";
    },
    /placeholder/,
  ],
  [
    "prerelease on the stable release path",
    (x) => {
      x.manifest.version = "0.1.0-beta.1";
    },
    /stable/,
  ],
  [
    "unrelated CLI tag",
    (x) => {
      x.tag = "cli-v0.1.0";
    },
    /tag/,
  ],
  [
    "mismatched tag version",
    (x) => {
      x.tag = "agent-adapters-v0.2.0";
    },
    /tag/,
  ],
  [
    "stale lock version",
    (x) => {
      x.lock.packages["packages/agent-adapters"].version = "0.0.0";
    },
    /lockfile/,
  ],
  [
    "stale lock name",
    (x) => {
      x.lock.packages["packages/agent-adapters"].name = "@withgauge/old-name";
    },
    /lockfile/,
  ],
  [
    "missing workspace lock",
    (x) => {
      delete x.lock.packages["packages/agent-adapters"];
    },
    /lockfile/,
  ],
  [
    "incorrect repository URL",
    (x) => {
      x.manifest.repository.url =
        "git+https://github.com/example/other-cli.git";
    },
    /repository/,
  ],
  [
    "wrong workspace",
    (x) => {
      x.manifest.repository.directory = "cli";
    },
    /repository/,
  ],
  [
    "restricted access",
    (x) => {
      x.manifest.publishConfig.access = "restricted";
    },
    /public/,
  ],
  [
    "wrong registry",
    (x) => {
      x.manifest.publishConfig.registry = "https://example.com/";
    },
    /registry/,
  ],
  [
    "pending release notes",
    (x) => {
      x.changelog = x.changelog.replace(
        "## Unreleased\n",
        "## Unreleased\n- Pending\n",
      );
    },
    /Unreleased entries/,
  ],
  [
    "missing changelog",
    (x) => {
      x.changelog = "";
    },
    /Unreleased section/,
  ],
  [
    "undated heading",
    (x) => {
      x.changelog = x.changelog.replace(" — 2026-10-15", "");
    },
    /Latest changelog/,
  ],
  [
    "stale latest heading",
    (x) => {
      x.changelog = x.changelog.replace("## 0.1.0", "## 0.0.1");
    },
    /Latest changelog/,
  ],
  [
    "duplicate heading",
    (x) => {
      x.changelog += "\n## 0.1.0 — 2026-10-14\n- Duplicate.\n";
    },
    /duplicate/,
  ],
  [
    "empty release notes",
    (x) => {
      x.changelog = x.changelog.replace("- Initial release.", "");
    },
    /changelog notes/,
  ],
];
for (const [label, change, message] of cases) {
  test(`rejects ${label}`, () => {
    const input = fixture();
    change(input);
    assert.throws(() => validateRelease(input), message);
  });
}
