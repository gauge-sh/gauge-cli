import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Command, CommanderError } from "commander";
import { rejectUnknownCommandHelp } from "./unknownCommand";

function cli(): { program: Command; output: string[] } {
  const output: string[] = [];
  const program = new Command("gauge")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => output.push(text),
      writeErr: () => {},
    })
    .option("--org <org>");
  const evals = program.command("eval");
  evals.command("list").action(() => {});
  program.command("run [id]").action(() => {});
  rejectUnknownCommandHelp(program);
  return { program, output };
}

function parse(args: string[]): { error?: CommanderError; output: string[] } {
  const { program, output } = cli();
  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    assert.ok(error instanceof CommanderError);
    return { error, output };
  }
  return { output };
}

describe("rejectUnknownCommandHelp", () => {
  it("prints help for known commands", () => {
    for (const args of [["-h"], ["eval", "-h"], ["eval", "list", "--help"]]) {
      const { error, output } = parse(args);
      assert.equal(error?.code, "commander.helpDisplayed", args.join(" "));
      assert.ok(output.length > 0);
    }
  });

  it("rejects an unknown command instead of printing its parent's help", () => {
    const { error, output } = parse(["foo", "-h"]);
    assert.equal(error?.code, "commander.unknownCommand");
    assert.match(error?.message ?? "", /unknown command 'foo'/);
    assert.deepEqual(output, []);
  });

  it("keeps Commander's suggestion", () => {
    const { error } = parse(["eval", "lst", "--help"]);
    assert.equal(error?.code, "commander.unknownCommand");
    assert.match(error?.message ?? "", /Did you mean list\?/);
  });

  it("leaves a help-looking option value alone", () => {
    const { error } = parse(["--org", "--help", "eval", "lst"]);
    assert.equal(error?.code, "commander.unknownCommand");
    assert.match(error?.message ?? "", /unknown command 'lst'[\s\S]*list/);
  });

  it("leaves commands that take arguments alone", () => {
    const { error } = parse(["run", "abc", "-h"]);
    assert.equal(error?.code, "commander.helpDisplayed");
  });
});
