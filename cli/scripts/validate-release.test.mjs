import assert from "node:assert/strict";
import test from "node:test";

import { validateRelease } from "./validate-release.mjs";

const valid = {
  tag: "cli-v1.2.3",
  packageJson: {
    name: "@withgauge/cli",
    version: "1.2.3",
    private: false,
    repository: {
      url: "git+https://github.com/gauge-sh/gauge-cli.git",
      directory: "cli",
    },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
  },
  packageLock: { version: "1.2.3", packages: { "": { version: "1.2.3" } } },
  changelog:
    "# Changelog\n\n## Unreleased\n\n## 1.2.3 — 2026-09-21\n\n- Shipped.\n",
};

test("accepts aligned release metadata", () => {
  assert.doesNotThrow(() => validateRelease(valid));
});

test("rejects package identity and publishing configuration drift", async (t) => {
  const cases = [
    ["package name", { name: "@example/cli" }, /public @withgauge\/cli/],
    ["private package", { private: true }, /public @withgauge\/cli/],
    ["missing repository", { repository: undefined }, /Release repository/],
    ["different repository", {
      repository: { url: "git+https://github.com/example/cli.git", directory: "cli" },
    }, /Release repository/],
    ["wrong package directory", {
      repository: { ...valid.packageJson.repository, directory: "packages/cli" },
    }, /Release repository/],
    ["restricted publication", {
      publishConfig: { ...valid.packageJson.publishConfig, access: "restricted" },
    }, /public access/],
    ["different registry", {
      publishConfig: { ...valid.packageJson.publishConfig, registry: "https://registry.example.com/" },
    }, /registry.npmjs.org/],
  ];
  for (const [name, changes, expected] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => validateRelease({ ...valid, packageJson: { ...valid.packageJson, ...changes } }),
        expected,
      );
    });
  }
});

test("rejects tag, lockfile, and changelog drift", async (t) => {
  await t.test("tag differs from package version", () => {
    assert.throws(
      () => validateRelease({ ...valid, tag: "cli-v1.2.2" }),
      /tag cli-v1\.2\.2 does not match package version/,
    );
  });

  await t.test("lockfile differs from package version", () => {
    assert.throws(
      () =>
        validateRelease({
          ...valid,
          packageLock: {
            version: "1.2.2",
            packages: { "": { version: "1.2.2" } },
          },
        }),
      /package-lock versions .* do not match package version/,
    );
  });

  await t.test("unreleased notes remain", () => {
    assert.throws(
      () =>
        validateRelease({
          ...valid,
          changelog: valid.changelog.replace(
            "## Unreleased\n",
            "## Unreleased\n\n- Not moved.\n",
          ),
        }),
      /still has entries under Unreleased/,
    );
  });

  await t.test("latest release differs from package version", () => {
    assert.throws(
      () =>
        validateRelease({
          ...valid,
          changelog: valid.changelog.replace(
            "## 1.2.3 — 2026-09-21",
            "## 1.2.2 — 2026-09-21",
          ),
        }),
      /exactly one dated 1\.2\.3 release heading/,
    );
  });
});
