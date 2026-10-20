import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Command, Option } from "commander";
import { type InitResult, register } from "./init";

function repo(t: TestContext, gaugeJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), "gauge-init-cmd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/app.git"],
    { cwd: root },
  );
  if (gaugeJson !== undefined)
    writeFileSync(join(root, "gauge.json"), gaugeJson);
  return root;
}

function isolateConfig(t: TestContext, signedIn = false): void {
  const home = mkdtempSync(join(tmpdir(), "gauge-init-home-"));
  const prior = {
    xdg: process.env.XDG_CONFIG_HOME,
    token: process.env.GAUGE_API_TOKEN,
  };
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.GAUGE_API_TOKEN;
  if (signedIn) {
    mkdirSync(join(home, "gauge"), { recursive: true });
    writeFileSync(join(home, "gauge", "credentials"), "gauge_test\n");
    writeFileSync(
      join(home, "gauge", "config.json"),
      '{"defaultOrg":"acme"}\n',
    );
  }
  t.after(() => {
    if (prior.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior.xdg;
    if (prior.token !== undefined) process.env.GAUGE_API_TOKEN = prior.token;
    rmSync(home, { recursive: true, force: true });
  });
}

async function run(
  t: TestContext,
  root: string,
  args: string[],
): Promise<{ result: InitResult; lines: string[] }> {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(String(line)));
  const program = new Command()
    .exitOverride()
    .option("--org <org>")
    .addOption(new Option("-o, --output <format>").default("table"))
    .option("--local")
    .option("--hosted");
  register(program, { cwd: root });
  await program.parseAsync(["init", ...args], { from: "user" });
  const json = lines.find((line) => line.startsWith("{"));
  return { result: json ? JSON.parse(json) : undefined, lines };
}

const gaugeJson = (root: string) =>
  JSON.parse(readFileSync(join(root, "gauge.json"), "utf8"));

for (const signedIn of [false, true])
  test(`init defaults local independently of login (${signedIn})`, async (t) => {
    isolateConfig(t, signedIn);
    const root = repo(t);
    const { result } = await run(t, root, ["-o", "json"]);
    assert.equal(result.backend, "local");
    assert.deepEqual(gaugeJson(root), { version: 2, inputs: {} });
    assert.equal(existsSync(join(root, "gauge-cases")), false);
  });
test("hosted init requires no account and changes only the private backend", async (t) => {
  isolateConfig(t);
  const root = repo(t, '{"version":2,"org":"acme","inputs":{}}');
  const { result } = await run(t, root, ["--hosted", "--cases", "-o", "json"]);
  assert.equal(result.backend, "hosted");
  assert.deepEqual(gaugeJson(root), { version: 2, org: "acme", inputs: {} });
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, ".gauge/config.json"), "utf8")),
    { version: 1, backend: "hosted" },
  );
  assert.ok(existsSync(join(root, "gauge-cases")));
});
test("invalid gauge.json is a usage error", async (t) => {
  isolateConfig(t);
  const root = repo(t, "{nope");
  await assert.rejects(run(t, root, []), /not valid JSON/);
});
