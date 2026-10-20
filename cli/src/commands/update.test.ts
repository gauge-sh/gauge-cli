import assert from "node:assert/strict";
import { it } from "node:test";
import { Command } from "commander";
import { CliError } from "../lib/client";
import { register } from "./update";

it("updates the latest global CLI without using the Gauge API", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("update must not use the Gauge API"),
  );
  t.mock.method(console, "error", () => {});
  const messages: string[] = [];
  t.mock.method(console, "log", (message: string) => messages.push(message));
  const program = new Command();
  let installs = 0;
  register(program, {
    platform: "linux",
    run: (command, args, options) => {
      installs++;
      assert.equal(command, "npm");
      assert.deepEqual(args, ["install", "--global", "@withgauge/cli@latest"]);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ["inherit", "inherit", "inherit"]);
      return { status: 0, signal: null };
    },
  });
  await program.parseAsync(["update"], { from: "user" });
  assert.equal(installs, 1);
  assert.match(messages[0], /Updated Gauge CLI/);
});

it("uses the npm Windows shim", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const program = new Command();
  register(program, {
    platform: "win32",
    run: (command, _args, options) => {
      assert.equal(command, "npm.cmd");
      assert.equal(options.shell, true);
      return { status: 0, signal: null };
    },
  });
  await program.parseAsync(["update"], { from: "user" });
});

it("keeps npm progress out of JSON stdout", async (t) => {
  t.mock.method(console, "error", () => {});
  const messages: string[] = [];
  t.mock.method(console, "log", (message: string) => messages.push(message));
  const program = new Command().option("-o, --output <format>");
  register(program, {
    run: (_command, _args, options) => {
      assert.deepEqual(options.stdio, ["inherit", 2, "inherit"]);
      return { status: 0, signal: null };
    },
  });
  await program.parseAsync(["update", "-o", "json"], { from: "user" });
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(messages[0]), {
    updated: true,
    package: "@withgauge/cli",
    tag: "latest",
  });
});

for (const [reason, result] of [
  ["npm exited with code 1", { status: 1, signal: null }],
  [
    "spawn npm ENOENT",
    { status: null, signal: null, error: new Error("spawn npm ENOENT") },
  ],
  ["SIGINT", { status: null, signal: "SIGINT" }],
] as const) {
  it(`reports ${reason} with a nonzero exit and no success message`, async (t) => {
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "log", () =>
      assert.fail("failed updates must not report success"),
    );
    const program = new Command();
    register(program, { run: () => result });
    await assert.rejects(
      program.parseAsync(["update"], { from: "user" }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.exitCode, 1);
        assert.ok(error.message.includes(reason));
        assert.match(
          error.message,
          /Retry with: npm install --global @withgauge\/cli@latest/,
        );
        return true;
      },
    );
  });
}
