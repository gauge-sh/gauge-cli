import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import { CliError } from "./client";
import { commandPath, errorReport, renderError, wantsJson } from "./errors";
import { register as registerMcp } from "../commands/mcp";

describe("errors", () => {
  it("preserves MCP capability guidance through local-mode error rendering", async () => {
    const program = new Command().option("--local").exitOverride();
    registerMcp(program);
    await assert.rejects(
      program.parseAsync(["--local", "mcp", "list"], { from: "user" }),
      (error: unknown) => {
        const report = errorReport(error, "mcp list", { local: "flag" });
        assert.match(report.message, /requires hosted Gauge/);
        assert.match(report.hint ?? "", /no local MCP configuration/);
        assert.match(report.hint ?? "", /gauge onboard/);
        assert.match(
          report.hint ?? "",
          /Do not issue hosted commands for a local-only request/,
        );
        return true;
      },
    );
  });

  it("adds docs, a hint, and a feedback command to every error", () => {
    const report = errorReport(
      new CliError("usage", "bad", { hint: "Do X." }),
      "run list",
    );
    assert.equal(
      renderError(report, false),
      [
        "error: bad",
        "Do X.",
        "Docs: https://docs.withgauge.com/agents",
        'Hit friction? gauge feedback -m "<what happened>" --kind friction --command "run list"',
        "",
      ].join("\n"),
    );
    assert.deepEqual(JSON.parse(renderError(report, true)).error, report);
  });

  it("skips the feedback line for a declined confirmation and for feedback itself", () => {
    assert.equal(
      errorReport(new CliError("usage", "aborted"), "run").feedback,
      undefined,
    );
    assert.equal(
      errorReport(new CliError("network", "down"), "feedback").feedback,
      undefined,
    );
  });

  it("keeps the feedback line in local mode, since feedback needs no account", () => {
    assert.match(
      errorReport(new CliError("usage", "bad"), "run", { local: "default" })
        .feedback ?? "",
      /^gauge feedback -m/,
    );
  });

  it("explains account errors in local mode instead of asking for an org", () => {
    const noOrg = new CliError("usage", "No organization selected.", {
      needsAccount: true,
    });
    const report = errorReport(noOrg, "eval list", { local: "workspace" });
    assert.equal(
      report.message,
      "`gauge eval list` requires hosted Gauge, but this project is set to run locally.",
    );
    assert.match(report.hint ?? "", /Pass --hosted.*`gauge init --hosted`/);
    assert.match(
      errorReport(noOrg, "eval list", { local: "default" }).hint ?? "",
      /Sign in with `gauge auth login` if needed/,
    );
    assert.equal(
      errorReport(noOrg, "eval list").message,
      "No organization selected.",
    );
  });

  it("turns raw errors into readable usage errors", () => {
    const missing = Object.assign(new Error("ENOENT: lstat '/x'"), {
      code: "ENOENT",
      path: "/x",
    });
    assert.deepEqual(
      [errorReport(missing, "run").message, errorReport(missing, "run").code],
      ["File not found: /x", "usage"],
    );
    const zod = z.object({ name: z.string() }).safeParse({});
    assert.equal(
      errorReport(new CliError("usage", `a.md: ${zod.error?.message}`), "run")
        .message,
      "a.md\n  name: Invalid input: expected string, received undefined",
    );
    assert.equal(
      errorReport(new CommanderError(1, "x", "error: unknown option '--y'"), "")
        .message,
      "unknown option '--y'",
    );
    assert.match(
      errorReport(new Error("boom"), "run").message,
      /^Unexpected error: boom/,
    );
  });

  it("reads the command path and JSON flag from argv", () => {
    const program = new Command();
    program.command("run").command("list");
    assert.equal(
      commandPath(program, ["--org", "acme", "run", "list", "--batch", "b1"]),
      "run list",
    );
    assert.equal(wantsJson(["run", "-o", "json"]), true);
    assert.equal(wantsJson(["run", "--output=json"]), true);
    assert.equal(wantsJson(["run", "-o", "table"]), false);
  });
});
