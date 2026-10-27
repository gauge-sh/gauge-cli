#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateRuntimeManifest, validateRuntimeSource } from "../../scripts/validate-runtime-release.mjs";

export function validateRelease({ tag, packageJson, packageLock, changelog }) {
  if (packageJson.name !== "@withgauge/cli" || packageJson.private !== false) {
    throw new Error("Release requires the public @withgauge/cli package");
  }
  if (
    packageJson.repository?.url !== "git+https://github.com/gauge-sh/gauge-cli.git" ||
    packageJson.repository?.directory !== "cli"
  ) {
    throw new Error("Release repository must point to gauge-sh/gauge-cli and its cli directory");
  }
  if (
    packageJson.publishConfig?.access !== "public" ||
    packageJson.publishConfig?.registry !== "https://registry.npmjs.org/"
  ) {
    throw new Error("Release must explicitly target public access on registry.npmjs.org");
  }
  const expectedTag = `cli-v${packageJson.version}`;

  if (tag !== expectedTag) {
    throw new Error(
      `tag ${tag} does not match package version (${expectedTag})`,
    );
  }

  const lockVersions = [
    packageLock.version,
    packageLock.packages?.[""]?.version,
  ];
  if (lockVersions.some((version) => version !== packageJson.version)) {
    throw new Error(
      `package-lock versions (${lockVersions.join(", ")}) do not match package version (${packageJson.version})`,
    );
  }

  const headings = [...changelog.matchAll(/^## (.+)$/gm)].map((match) => ({
    label: match[1],
    index: match.index,
  }));
  const unreleased = headings.filter(
    (heading) => heading.label === "Unreleased",
  );
  if (unreleased.length !== 1 || headings[0]?.label !== "Unreleased") {
    throw new Error(
      "CHANGELOG.md must begin with exactly one Unreleased section",
    );
  }

  const firstRelease = headings[1];
  if (!firstRelease) {
    throw new Error("CHANGELOG.md has no release heading");
  }

  const unreleasedBody = changelog
    .slice(unreleased[0].index + "## Unreleased".length, firstRelease.index)
    .trim();
  if (unreleasedBody) {
    throw new Error("CHANGELOG.md still has entries under Unreleased");
  }

  const releasePattern = new RegExp(
    `^## ${packageJson.version.replaceAll(".", "\\.")} — \\d{4}-\\d{2}-\\d{2}$`,
    "gm",
  );
  const releases = [...changelog.matchAll(releasePattern)];
  if (releases.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one dated ${packageJson.version} release heading`,
    );
  }
  if (releases[0].index !== firstRelease.index) {
    throw new Error(
      `CHANGELOG.md latest release does not match package version (${packageJson.version})`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const tag = process.argv[2] ?? `cli-v${packageJson.version}`;

  validateRelease({
    tag,
    packageJson,
    packageLock: JSON.parse(await readFile("package-lock.json", "utf8")),
    changelog: await readFile("CHANGELOG.md", "utf8"),
  });
  const runtime = JSON.parse(await readFile("runtime-manifest.json", "utf8"));
  validateRuntimeManifest(runtime);
  validateRuntimeSource(runtime, fileURLToPath(new URL("../../", import.meta.url)));
  const gateway = JSON.parse(await readFile("gateway-manifest.json", "utf8"));
  validateRuntimeManifest(gateway, { gateway: true });
  validateRuntimeSource(gateway, fileURLToPath(new URL("../../", import.meta.url)));
  console.log(`release metadata is consistent for ${tag}`);
}
