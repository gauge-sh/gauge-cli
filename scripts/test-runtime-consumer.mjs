import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "gauge-runtime-consumer-"));
const manifest = JSON.parse(await readFile(join(root, "cli/runtime-manifest.json"), "utf8"));
const destinationIndex = process.argv.indexOf("--pack-destination");
const destination = destinationIndex === -1 ? temporary : resolve(process.argv[destinationIndex + 1]);
try {
  if (destination !== temporary) await mkdir(destination);
  const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000, ...options });
  await mkdir(join(temporary, "home"));
  await mkdir(join(temporary, "docker"));
  await writeFile(join(temporary, "npmrc"), "");
  await writeFile(join(temporary, "global-npmrc"), "");
  const env = {
    PATH: process.env.PATH,
    HOME: join(temporary, "home"),
    XDG_CONFIG_HOME: join(temporary, "config"),
    DOCKER_CONFIG: join(temporary, "docker"),
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    NPM_CONFIG_USERCONFIG: join(temporary, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(temporary, "global-npmrc"),
    NPM_CONFIG_CACHE: join(temporary, "npm-cache"),
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    GAUGE_TELEMETRY_DISABLED: "1",
  };
  const [archive] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: join(root, "cli"), env }));
  await writeFile(join(temporary, "package.json"), '{"private":true,"type":"module"}');
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(destination, archive.filename)], { cwd: temporary, env });
  const entry = join(temporary, "node_modules/@withgauge/cli/dist/index.js");
  if (process.argv.includes("--pull")) {
    assert.match(manifest.digest ?? "", /^sha256:[a-f0-9]{64}$/, "Anonymous qualification requires a real published digest");
    run(process.execPath, [entry, "local", "runtime", "pull", "-o", "json"], { cwd: temporary, env });
  }
  const result = JSON.parse(run(process.execPath, [entry, "local", "runtime", "inspect", "-o", "json"], { cwd: temporary, env }));
  assert.equal(result.ready, true);
  assert.equal(result.reference, manifest.digest ? `${manifest.repository}@${manifest.digest}` : `${manifest.repository}:${manifest.version}`);
  assert.match(result.imageId, /^sha256:[a-f0-9]{64}$/);
  if (process.argv.includes("--pull")) {
    assert.equal(result.repoDigest, `${manifest.repository}@${manifest.digest}`);
    const [image] = JSON.parse(run("docker", ["image", "inspect", result.imageId], { env }));
    assert.equal(image.Config.Labels["org.opencontainers.image.revision"], manifest.revision);
  }
  run("bash", [join(root, "scripts/test-runtime-image.sh"), result.imageId], { cwd: temporary, env });
  console.log(`Isolated public CLI tarball: ${archive.filename}; runtime ${result.imageId}; ${process.argv.includes("--pull") ? "anonymous registry pull verified" : "local image qualification only (publication not verified)"}.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
