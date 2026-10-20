import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { it, type TestContext } from "node:test";
import { Command } from "commander";
import { CLI_VERSION } from "../version";
import { registerTelemetry } from "./telemetry";

function setup(t: TestContext) {
  const previous = process.env.GAUGE_TELEMETRY_DISABLED;
  delete process.env.GAUGE_TELEMETRY_DISABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.GAUGE_TELEMETRY_DISABLED;
    else process.env.GAUGE_TELEMETRY_DISABLED = previous;
  });
  const program = new Command().name("gauge").option("--org <org>");
  let calls = 0;
  program
    .command("run")
    .command("get <id>")
    .alias("show")
    .option("--token <token>")
    .action(() => {
      calls++;
    });
  registerTelemetry(program, "/worker.js");
  return { program, calls: () => calls };
}

it("captures canonical commands only, with no arguments or flag values", async (t) => {
  const { program, calls } = setup(t);
  const child = Object.assign(new EventEmitter(), { unref() {} });
  const unref = t.mock.method(child, "unref");
  const spawn = t.mock.method(
    childProcess,
    "spawn",
    () => child as childProcess.ChildProcess,
  );
  const before = Date.now();
  await program.parseAsync(
    [
      "--org",
      "private-org",
      "run",
      "show",
      "secret-id",
      "--token",
      "secret-token",
    ],
    { from: "user" },
  );
  assert.equal(calls(), 1);
  assert.equal(spawn.mock.callCount(), 1);
  const [executable, args, options] = spawn.mock.calls[0]
    .arguments as unknown as [string, string[], object];
  assert.equal(executable, process.execPath);
  assert.equal(args[0], "/worker.js");
  const event = JSON.parse(args[1]);
  assert.deepEqual(event, {
    command: "run get",
    timestamp: event.timestamp,
    cliVersion: CLI_VERSION,
  });
  assert.ok(
    Date.parse(event.timestamp) >= before &&
      Date.parse(event.timestamp) <= Date.now(),
  );
  assert.deepEqual(options, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  assert.equal(unref.mock.callCount(), 1);
  assert.doesNotThrow(() =>
    child.emit("error", new Error("spawn failed asynchronously")),
  );
});

it("does not launch a worker when opted out or managing telemetry", async (t) => {
  const { program, calls } = setup(t);
  const spawn = t.mock.method(childProcess, "spawn", () => {
    throw new Error("must not spawn");
  });
  process.env.GAUGE_TELEMETRY_DISABLED = "1";
  await program.parseAsync(["run", "get", "id"], { from: "user" });
  delete process.env.GAUGE_TELEMETRY_DISABLED;
  program
    .command("telemetry")
    .command("enable")
    .action(() => {});
  await program.parseAsync(["telemetry", "enable"], { from: "user" });
  assert.equal(calls(), 1);
  assert.equal(spawn.mock.callCount(), 0);
});

it("synchronous launch errors cannot stop command execution", async (t) => {
  const { program, calls } = setup(t);
  t.mock.method(childProcess, "spawn", () => {
    throw new Error("resource exhausted");
  });
  await program.parseAsync(["run", "get", "id"], { from: "user" });
  assert.equal(calls(), 1);
});

it("records invocation before an action fails, preserving the original error", async (t) => {
  const { program } = setup(t);
  const child = Object.assign(new EventEmitter(), { unref() {} });
  const spawn = t.mock.method(
    childProcess,
    "spawn",
    () => child as childProcess.ChildProcess,
  );
  const failure = new Error("command failed");
  program.command("fail").action(() => {
    throw failure;
  });
  await assert.rejects(
    program.parseAsync(["fail"], { from: "user" }),
    (error) => error === failure,
  );
  assert.equal(spawn.mock.callCount(), 1);
});
