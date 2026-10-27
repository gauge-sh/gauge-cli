import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "pack-destination": { type: "string" }, "registry-dependencies": { type: "boolean", default: false } } });
const destination = values["pack-destination"] ? resolve(values["pack-destination"]) : undefined;
if (destination) mkdirSync(destination);

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "gauge-local-package-"));
const dev = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies;
try {
  const pack = (directory) => JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
    cwd: join(root, directory), encoding: "utf8",
  }))[0];
  const packed = pack("packages/local");
  const modules = ["credentials", "docker", "driver", "fsAtomic", "gateway", "index", "scripts", "session", "types", "worker", "workspace"];
  assert.deepEqual(packed.files.map((f) => f.path).sort(), [
    "LICENSE", "README.md", "package.json", "image/Dockerfile", "image/gauge-path.sh",
    ...["Dockerfile", "entrypoint.sh", "fixtures.py", "health.py", "test_fixtures.py"].map(name => `gateway/${name}`),
    ...modules.flatMap((name) => [`dist/${name}.js`, `dist/${name}.d.ts`]),
  ].sort(), "Unexpected local-execution distribution contents");
  for (const { path } of packed.files) {
    const contents = readFileSync(join(root, "packages/local", path), "utf8");
    assert.doesNotMatch(contents,
      /github\.com\/gauge-sh\/(?!gauge-cli(?:[\/."\s]|$)|gauge-skills(?:[\/."\s]|$))[\w.-]+|@[\w-]+\/api-schemas|\b[A-Z]{2,}-\d{2,}\b|\/api\/(?:v1\/)?admin(?:\/|\b)|\/(?:home|Users)\/(?!node\/)[A-Za-z0-9_][\w.-]*\//,
      `Private implementation reference in local-execution distribution: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, "packages/local/package.json"), "utf8"));
  const adaptersManifest = JSON.parse(readFileSync(join(root, "packages/agent-adapters/package.json"), "utf8"));
  if (!values["registry-dependencies"])
    assert.equal(adaptersManifest.version, manifest.dependencies["@withgauge/agent-adapters"], "Workspace adapter version must match the release dependency; otherwise test with --registry-dependencies");
  const adapters = values["registry-dependencies"] ? undefined : pack("packages/agent-adapters");
  const consumer = join(temporary, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    private: true, type: "module",
    dependencies: {
      "@withgauge/local-execution": `file:${join(temporary, packed.filename)}`,
      ...(adapters ? { "@withgauge/agent-adapters": `file:${join(temporary, adapters.filename)}` } : {}),
    },
    devDependencies: { typescript: dev.typescript, "@types/node": dev["@types/node"] },
  }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer, stdio: "pipe" });
  writeFileSync(join(consumer, "test.ts"), `
    import assert from "node:assert/strict";
    import { startSession, getSessionStatus, sendPrompt, answerQuestion, finishSession, stopSession, readSessionEventsNdjson, type SessionSpec } from "@withgauge/local-execution";
    for (const fn of [startSession, getSessionStatus, sendPrompt, answerQuestion, finishSession, stopSession, readSessionEventsNdjson]) assert.equal(typeof fn, "function");
    const spec: SessionSpec = { image: "gauge-session-fixture:test", agent: { kind: "claude-code", model: "fixture" }, auth: { mode: "setup_token" }, workspace: { repo: "https://github.com/example/fixture", ref: "master" }, resources: [], prompt: { text: "hello" }, limits: { turnTimeoutS: 30, responseTimeoutS: null, maxTurns: 5 } };
    await assert.rejects(import(String("@withgauge/local-execution/dist/worker.js")), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    if (process.env.GAUGE_DOCKER_FIXTURES === "1") {
      const directory = ${JSON.stringify(join(consumer, "session"))};
      try {
        await startSession({ directory, spec, credentials: { env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-only" }, homeDir: ${JSON.stringify(consumer)} }, runtimeDirectory: ${JSON.stringify(tmpdir())} });
        const wait = async (state: string) => {
          for (let i = 0; i < 150; i++) {
            const s = await getSessionStatus(directory);
            if (s.state === state) return s;
            assert.notEqual(s.state, "failed", s.detail);
            await new Promise(r => setTimeout(r, 100));
          }
          throw new Error("session did not settle");
        };
        await wait("waiting");
        await sendPrompt(directory, 1, "hello again");
        assert.equal((await wait("waiting")).turn, 2);
        await finishSession(directory); await wait("completed");
      } finally { await stopSession(directory); }
    }
    console.log("Isolated local-execution tarball: exports, declarations and worker entry point verified.");
  `);
  execFileSync(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc"), "--module", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", "test.ts"], { cwd: consumer, stdio: "pipe" });
  execFileSync(process.execPath, ["test.js"], { cwd: consumer, stdio: "inherit" });
  if (destination) {
    const artifact = join(destination, packed.filename);
    copyFileSync(join(temporary, packed.filename), artifact);
    console.log(`Validated release artifact: ${artifact}`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
