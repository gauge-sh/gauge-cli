import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = "packages/agent-adapters";
const repository = "git+https://github.com/gauge-sh/gauge-cli.git";

export function validateRelease({ tag, manifest, lock, changelog }, {
  workspace: targetWorkspace = workspace,
  tagPrefix = "agent-adapters",
  packageName,
} = {}) {
  if (manifest.private !== false) {
    throw new Error(
      "Release is disabled: the package must explicitly set private: false",
    );
  }
  if (!/^@withgauge\/[a-z0-9][a-z0-9._-]*$/.test(manifest.name ?? "")) {
    throw new Error("Release requires a chosen @withgauge package name");
  }
  if (packageName && manifest.name !== packageName) {
    throw new Error(`Release requires package name ${packageName}`);
  }
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      manifest.version ?? "",
    ) ||
    manifest.version === "0.0.0"
  ) {
    throw new Error("Release requires a non-placeholder stable x.y.z version");
  }
  if (tag !== `${tagPrefix}-v${manifest.version}`) {
    throw new Error(`Release tag must match ${tagPrefix}-v<package version>`);
  }
  const locked = lock.packages?.[targetWorkspace];
  if (locked?.name !== manifest.name || locked?.version !== manifest.version) {
    throw new Error(
      "Workspace lockfile name/version does not match the package",
    );
  }
  if (
    manifest.repository?.url !== repository ||
    manifest.repository?.directory !== targetWorkspace
  ) {
    throw new Error(
      "Package repository metadata must identify this publishing repository and workspace",
    );
  }
  if (
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.registry !== "https://registry.npmjs.org/"
  ) {
    throw new Error(
      "Release must explicitly target public access on registry.npmjs.org",
    );
  }

  const headings = [...changelog.matchAll(/^## (.+)$/gm)];
  if (
    headings[0]?.[1] !== "Unreleased" ||
    headings.filter((h) => h[1] === "Unreleased").length !== 1
  ) {
    throw new Error(
      "CHANGELOG.md must begin with exactly one Unreleased section",
    );
  }
  const latest = headings[1];
  if (
    !latest ||
    !/^\d+\.\d+\.\d+ — \d{4}-\d{2}-\d{2}$/.test(latest[1]) ||
    !latest[1].startsWith(`${manifest.version} — `)
  ) {
    throw new Error(
      "Latest changelog release must match the package version and include YYYY-MM-DD",
    );
  }
  if (
    headings.filter((h) => h[1].startsWith(`${manifest.version} — `)).length !==
    1
  ) {
    throw new Error("CHANGELOG.md contains duplicate release headings");
  }
  if (
    changelog
      .slice(headings[0].index + headings[0][0].length, latest.index)
      .trim()
  ) {
    throw new Error(
      "Move Unreleased entries into the dated release before publishing",
    );
  }
  if (
    !changelog.slice(latest.index + latest[0].length, headings[2]?.index).trim()
  ) {
    throw new Error("The release must have changelog notes");
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const manifest = json(`${workspace}/package.json`);
  const tag = process.argv[2] ?? `agent-adapters-v${manifest.version}`;
  validateRelease({
    tag,
    manifest,
    lock: json("package-lock.json"),
    changelog: readFileSync(resolve(root, workspace, "CHANGELOG.md"), "utf8"),
  });
  console.log(`Release metadata is consistent for ${tag}`);
}
