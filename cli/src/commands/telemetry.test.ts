import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Command } from "commander";
import { register } from "./telemetry";

it("manages preferences and reports the environment override without creating an identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gauge-consent-"));
  const previous = {
    xdg: process.env.XDG_CONFIG_HOME,
    disabled: process.env.GAUGE_TELEMETRY_DISABLED,
  };
  process.env.XDG_CONFIG_HOME = root;
  delete process.env.GAUGE_TELEMETRY_DISABLED;
  t.after(async () => {
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.xdg;
    if (previous.disabled === undefined)
      delete process.env.GAUGE_TELEMETRY_DISABLED;
    else process.env.GAUGE_TELEMETRY_DISABLED = previous.disabled;
    await rm(root, { recursive: true, force: true });
  });
  const output: string[] = [];
  t.mock.method(console, "log", (value: string) => output.push(value));
  async function run(action: string) {
    const program = new Command().option(
      "-o, --output <format>",
      "format",
      "table",
    );
    register(program);
    await program.parseAsync(["telemetry", action, "-o", "json"], {
      from: "user",
    });
    return JSON.parse(output.pop()!);
  }
  assert.deepEqual(await run("status"), { enabled: true, source: "default" });
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await run("disable"), {
    enabled: false,
    source: "preference",
  });
  assert.deepEqual(await run("status"), {
    enabled: false,
    source: "preference",
  });
  process.env.GAUGE_TELEMETRY_DISABLED = "1";
  assert.deepEqual(await run("enable"), {
    enabled: false,
    source: "environment",
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "gauge/telemetry.json"), "utf8")),
    { enabled: true },
  );
  delete process.env.GAUGE_TELEMETRY_DISABLED;
  assert.deepEqual(await run("status"), {
    enabled: true,
    source: "preference",
  });
  assert.deepEqual(await readdir(join(root, "gauge")), ["telemetry.json"]);
});
