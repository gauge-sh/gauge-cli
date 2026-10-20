import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRelease } from "./validate-agent-adapters-release.mjs";

const workspace = "packages/local";

export function validateLocalRelease(input) {
  validateRelease(input, {
    workspace,
    tagPrefix: "local-execution",
    packageName: "@withgauge/local-execution",
  });
  const dependencies = input.manifest.dependencies ?? {};
  if (Object.keys(dependencies).length !== 1 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(dependencies["@withgauge/agent-adapters"] ?? "")) {
    throw new Error("local-execution must depend on one exact published agent-adapters version");
  }
  if (input.lock.packages[workspace].dependencies?.["@withgauge/agent-adapters"] !== dependencies["@withgauge/agent-adapters"]) {
    throw new Error("Lockfile dependency must match the pinned agent-adapters version");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const manifest = json(`${workspace}/package.json`);
  const tag = process.argv[2] ?? `local-execution-v${manifest.version}`;
  validateLocalRelease({
    tag, manifest, lock: json("package-lock.json"),
    changelog: readFileSync(resolve(root, workspace, "CHANGELOG.md"), "utf8"),
  });
  console.log(`Release metadata is consistent for ${tag}`);
}
