import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { "pack-destination": { type: "string" } },
});
const destination = values["pack-destination"]
  ? resolve(values["pack-destination"])
  : undefined;
if (destination) mkdirSync(destination);

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = join(root, "packages/agent-adapters");
const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
const dev = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).devDependencies;
const temporary = mkdtempSync(join(tmpdir(), "gauge-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  const [packed] = JSON.parse(
    execFileSync(
      npm,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: pkg, encoding: "utf8" },
    ),
  );
  const modules = [
    "antigravity",
    "claudeCode",
    "claudeEvidence",
    "codex",
    "cursor",
    "index",
    "native",
    "openCode",
    "openCodeTransport",
    "pi",
    "piTransport",
    "processor",
    "session",
    "state",
    "types",
  ];
  const expectedFiles = [
    "package.json",
    "README.md",
    "LICENSE",
    ...modules.flatMap((name) => [`dist/${name}.js`, `dist/${name}.d.ts`]),
  ];
  assert.deepEqual(
    packed.files.map(({ path }) => path).sort(),
    expectedFiles.sort(),
    "Packed files differ from the reviewed distribution inventory",
  );
  const consumer = join(temporary, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        [manifest.name]: `file:${join(temporary, packed.filename)}`,
      },
      devDependencies: {
        typescript: dev.typescript,
        "@types/node": dev["@types/node"],
      },
    }),
  );
  execFileSync(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer, stdio: "pipe" },
  );
  writeFileSync(
    join(consumer, "index.ts"),
    `
import assert from "node:assert/strict";
import { NativeSession, PiRpcTransport, OpenCodeSseTransport, type EvidencePayload, type DuplexProcess } from ${JSON.stringify(manifest.name)};
import { classifyCodexEvent, classifyAntigravityEvent, decodeAntigravityEvidence, reduceAntigravityUsage } from ${JSON.stringify(`${manifest.name}/native`)};
const session = new NativeSession("codex");
const native = { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } };
const result = session.observe(JSON.stringify(native), "2026-10-15T00:00:00.000Z");
const evidence: readonly EvidencePayload[] = result.payloads;
assert.equal(result.terminal?.status, "complete");
assert.deepEqual(evidence, [{ type: "usage", input_tokens: 5, output_tokens: 2 }]);
assert.equal(classifyCodexEvent(native), "result");
const restored = NativeSession.restore(JSON.parse(JSON.stringify(session.snapshot())));
restored.beginTurn();
assert.equal(restored.snapshot().projection.turn.number, 2);
const agy = new NativeSession("antigravity");
const agyRecord = (n: number) => ({ event: "result", result: { status: "SUCCESS", response: "done", usage: { input_tokens: 10 * n, output_tokens: 2 * n } } });
const firstAgy = agy.observe(JSON.stringify(agyRecord(1)), "2026-10-16T00:00:00.000Z");
assert.equal(classifyAntigravityEvent(agyRecord(1)), "result");
assert.deepEqual(decodeAntigravityEvidence(firstAgy.event), [{ type: "agent_message", text: "done" }]);
assert.deepEqual(reduceAntigravityUsage(agyRecord(1)).payload, { type: "usage", input_tokens: 10, output_tokens: 2 });
const resumedAgy = NativeSession.restore(JSON.parse(JSON.stringify(agy.snapshot())));
resumedAgy.beginTurn();
const secondAgy = resumedAgy.observe(JSON.stringify(agyRecord(2)), "2026-10-16T00:00:01.000Z");
assert.equal(secondAgy.terminal?.status, "complete");
assert.deepEqual(secondAgy.payloads.filter(p => p.type === "usage"), [{ type: "usage", input_tokens: 10, output_tokens: 2 }]);
const process: DuplexProcess = {
  async *stdout() {}, async write(_data: string) {}, closeStdin() {},
  async wait() { return { code: 0, signal: null }; }, kill() {}, stderrTail() { return ""; },
};
await new PiRpcTransport(process).waitForReader();
await new OpenCodeSseTransport(process).waitForReader();
await assert.rejects(import(String(${JSON.stringify(`${manifest.name}/dist/processor.js`)})), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log("Isolated tarball consumer: runtime exports, declarations, and private-path restriction passed.");
`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        outDir: "dist",
        types: ["node"],
      },
      include: ["index.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [join(consumer, "node_modules/typescript/bin/tsc"), "-p", consumer],
    { cwd: consumer, stdio: "inherit" },
  );
  execFileSync(process.execPath, [join(consumer, "dist/index.js")], {
    cwd: consumer,
    stdio: "inherit",
  });
  if (destination) {
    const artifact = join(destination, packed.filename);
    copyFileSync(join(temporary, packed.filename), artifact);
    console.log(`Validated release artifact: ${artifact}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
