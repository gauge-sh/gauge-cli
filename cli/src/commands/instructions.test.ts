import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Command } from "commander";
import {
  documentBody,
  instructions,
  resolveTopic,
  TOPIC_NAMES,
  TOPICS,
} from "../instructions";
import type { GaugeState, Mode } from "../lib/gaugeState";
import { formatCommandHelp } from "../lib/rootHelp";
import { readGaugeState } from "../lib/gaugeState";
import { register } from "./instructions";

function state(mode: Mode): GaugeState {
  return {
    mode,
    source: "workspace",
    root: "/workspace",
    inRepo: true,
    config: {},
    signedIn: true,
  };
}

const BODY_LINE_BUDGET = 50;
const RUN_LINE_BUDGET = 80;
const OVERVIEW_LINE_BUDGET = 100;

describe("gauge instructions", () => {
  it("keeps every topic inside its line budget", () => {
    for (const [topic, skill] of Object.entries(TOPICS)) {
      const lines = documentBody(skill.hosted).trim().split("\n").length;
      const budget =
        topic === "root"
          ? OVERVIEW_LINE_BUDGET
          : topic === "run"
            ? RUN_LINE_BUDGET
            : BODY_LINE_BUDGET;
      assert.ok(
        lines <= budget,
        `${topic} is ${lines} lines, over the ${budget}-line budget`,
      );
    }
  });

  it("keeps every local page inside its line budget", () => {
    for (const [topic, skill] of Object.entries(TOPICS)) {
      if (!skill.local) continue;
      const lines = documentBody(skill.local).trim().split("\n").length;
      assert.ok(lines <= RUN_LINE_BUDGET, `${topic} local is ${lines} lines`);
    }
  });

  it("identifies the backend and limits hosted-only topics", () => {
    for (const topic of ["root", ...TOPIC_NAMES]) {
      const hosted = documentBody(instructions(topic, state("hosted")));
      assert.match(
        hosted,
        /^\n> Mode: hosted \(from \.gauge\/config\.json\)\. Pass --local to switch for this command\./,
      );
      const local = documentBody(instructions(topic, state("local")));
      assert.match(
        local,
        /^\n> Mode: local \(from \.gauge\/config\.json\)\. Pass --hosted to switch for this command\./,
      );
      if (TOPICS[topic].local || TOPICS[topic].shared)
        assert.doesNotMatch(local, /This topic is hosted only/);
      else assert.match(local, /This topic is hosted only/);
    }
    assert.match(instructions("run", state("local")), /# Run \(local\)/);
    assert.match(instructions("eval", state("local")), /# Eval sets/);
    assert.match(
      instructions("preference", state("local")),
      /# Preference prompts/,
    );
  });

  it("offers workspace setup without deriving the backend from login", () => {
    const unset = {
      ...state("local"),
      root: undefined,
      config: undefined,
      signedIn: false,
    };
    for (const topic of ["root", ...TOPIC_NAMES]) {
      assert.match(
        instructions(topic, unset),
        /> Run `gauge init` to initialize this directory/,
      );
      assert.doesNotMatch(instructions(topic, unset), /hosted when.*signed in/);
    }
    assert.match(instructions("root", state("local")), /\n> Next: /);
    assert.doesNotMatch(instructions("run", state("local")), /> Next: /);
    assert.doesNotMatch(
      instructions("root", unset, { setup: false }),
      /> Next:/,
    );
  });

  it("emits installable frontmatter naming the skill", () => {
    for (const skill of Object.values(TOPICS)) {
      assert.match(skill.hosted, /^---\n/);
      assert.match(skill.hosted, new RegExp(`\\nname: ${skill.name}\\n`));
      assert.match(skill.hosted, /\ndescription: /);
    }
  });

  it("resolves a topic by name and rejects an unknown one", () => {
    assert.equal(resolveTopic("OPTIMIZATIONS").name, "gauge-optimizations");
    assert.equal(resolveTopic(" OPTIMIZATION "), resolveTopic("optimizations"));
    assert.equal(resolveTopic(" RUN ").name, "gauge-run");
    assert.equal(resolveTopic(" EVAL ").name, "gauge-eval");
    assert.equal(resolveTopic("preference").name, "gauge-preference");
    assert.throws(() => resolveTopic("evals"), /unknown topic/);
    assert.throws(() => resolveTopic("suite"), /unknown topic/);
    assert.throws(() => resolveTopic("missing-feature"), /unknown topic/);
  });

  it("prints the eval guidance and migration example through the command", async (t) => {
    const output: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => {
      output.push(chunk);
      return true;
    });
    const program = new Command().option("--hosted");
    register(program);
    await program.parseAsync(["--hosted", "instructions", "run"], {
      from: "user",
    });
    const markdown = output.join("");
    assert.match(markdown, /^---\nname: gauge-run\n/);
    assert.match(markdown, /## Model selection/);
    assert.match(
      markdown,
      /Migrate this app from its current feature-flag provider to the replacement provider/,
    );
    assert.match(markdown, /\*\*Complete migration:\*\*/);
    assert.match(markdown, /\*\*Preserved behavior:\*\*/);
    assert.match(markdown, /\*\*Verified working application:\*\*/);
    assert.match(markdown, /\*\*Appropriate product surfaces:\*\*/);
    assert.match(markdown, /Missing source rules limit the parity claim/);
  });

  it("lists canonical modules", async (t) => {
    const output: string[] = [];
    t.mock.method(console, "log", (line: string) => output.push(line));
    t.mock.method(console, "error", () => {});
    const program = new Command();
    register(program);
    await program.parseAsync(["instructions", "--list"], { from: "user" });
    assert.deepEqual(output, [
      "init",
      "hillclimb",
      "run",
      "eval",
      "preference",
      "session-analysis",
      "optimization",
    ]);
  });

  it("prints every named module through the command", async (t) => {
    const output: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => {
      output.push(chunk);
      return true;
    });
    for (const topic of TOPIC_NAMES) {
      output.length = 0;
      const program = new Command();
      register(program);
      await program.parseAsync(["instructions", topic], { from: "user" });
      assert.equal(output.join(""), instructions(topic, readGaugeState({})));
    }
  });

  it("prints setup and essential module summaries by default", async (t) => {
    const all = instructions();
    assert.equal(all.split("\n---\n").length, 2, "exactly one frontmatter");
    assert.match(all, /^---\nname: gauge\n/);
    assert.doesNotMatch(all, /npm install|Node\.js/);
    assert.match(all, /gauge auth login/);
    assert.match(all, /gauge orgs use <org>/);
    assert.match(all, /-o json/);
    assert.match(all, /Confirm before launches spend credits/);
    assert.doesNotMatch(all, /Migration prompt and criteria|## The loop/);
    for (const topic of TOPIC_NAMES) {
      const body = documentBody(TOPICS[topic].hosted).trim();
      assert.ok(!all.includes(body), `${topic}: overview omits the full page`);
    }
    const topLevel = all.split("\n").filter((line) => line.startsWith("# "));
    assert.deepEqual(topLevel, ["# Gauge"], "one top-level heading");

    const output: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => {
      output.push(chunk);
      return true;
    });
    const program = new Command();
    register(program);
    await program.parseAsync(["instructions"], { from: "user" });
    assert.equal(output.join(""), instructions(undefined, readGaugeState({})));
    assert.equal(instructions("root"), all);
  });

  it("gives each module about 100 words and a command for its full guidance", () => {
    const modules = ["run", "session-analysis", "optimization"];
    const sections = instructions().split(/^### /m).slice(1);
    assert.equal(sections.length, modules.length);
    for (const section of sections) {
      const summary = section
        .slice(section.indexOf("\n") + 1)
        .split("\n\nFull guidance")[0]
        .trim();
      const words = summary.split(/\s+/).length;
      assert.ok(
        words >= 90 && words <= 110,
        `${section.split("\n")[0]}: ${words} words`,
      );
    }
    for (const topic of modules)
      assert.ok(
        instructions().includes(`\`gauge instructions ${topic}\``),
        topic,
      );
  });

  it("keeps the complete optimization workflow in its named page", () => {
    const optimization = instructions("optimization");
    assert.match(optimization, /## The loop/);
    assert.match(optimization, /gauge optimizations diagnose/);
    assert.match(optimization, /--idempotency-key/);
    assert.match(optimization, /baselines --eval/);
    assert.match(optimization, /--from-run/);
    assert.match(optimization, /selects checkpoints automatically/);
    assert.match(optimization, /Checkpoints are saved states of baseline runs/);
    assert.match(optimization, /candidateDelivery/);
    assert.ok(
      optimization.indexOf("baselines --eval") <
        optimization.indexOf("optimizations start"),
    );
    assert.equal(instructions("optimizations"), optimization);
  });

  it("ends each command topic with its help command", () => {
    for (const topic of TOPIC_NAMES) {
      const command = TOPICS[topic].command;
      const markdown = instructions(topic);
      if (command)
        assert.ok(
          markdown.endsWith(
            `\nRun \`gauge ${command} -h\` for usage and flag options.\n`,
          ),
          topic,
        );
      else assert.doesNotMatch(markdown, / -h` for usage/);
    }
    assert.doesNotMatch(instructions(), / -h` for usage/);
  });

  it("prints command help for a command name that is not a topic", async (t) => {
    const output: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => {
      output.push(chunk);
      return true;
    });
    const program = new Command();
    register(program);
    program.command("auth").description("Authenticate the CLI");
    program.command("run").description("Start runs");
    program.command("optimizations");
    await program.parseAsync(["instructions", " AUTH "], { from: "user" });
    const text = output.join("");
    assert.match(text, /^"auth" is a command, not an instructions topic\./);
    assert.match(text, /`gauge auth -h`/);
    assert.match(text, /Authenticate the CLI/);

    output.length = 0;
    await program.parseAsync(["instructions", "optimizations"], { from: "user" });
    assert.match(output.join(""), /^---\nname: gauge-optimizations\n/);

    output.length = 0;
    await program.parseAsync(["instructions", "run"], { from: "user" });
    assert.match(output.join(""), /^---\nname: gauge-run\n/);
  });

  it("links command help to its topic and shows only program options as global", () => {
    const program = new Command()
      .option("--local")
      .option("--version")
      .configureHelp({
        showGlobalOptions: true,
        formatHelp: formatCommandHelp,
      });
    const run = program.command("run").option("--eval <id>");
    const compare = run.command("compare");
    const help = compare.helpInformation();
    const global = help.slice(help.indexOf("GLOBAL OPTIONS"));
    assert.match(global, /--local/);
    assert.doesNotMatch(global, /--eval|--version/);
    assert.match(help, /Run gauge instructions run for explicit guidance\./);
    assert.doesNotMatch(
      program.command("auth").helpInformation(),
      /gauge instructions/,
    );
  });

  it("hints at command help for an unknown topic", () => {
    assert.throws(
      () => resolveTopic("nope"),
      (error: { hint?: string }) => /gauge <command> -h/.test(error.hint ?? ""),
    );
  });

  it("rejects retired topics without compatibility aliases", () => {
    for (const topic of ["evals", "suite"])
      assert.throws(() => resolveTopic(topic), /unknown topic/);
  });
});
