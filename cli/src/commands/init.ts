import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { CliError } from "../lib/client";
import { resolveOutput } from "../lib/context";
import { detectAgent } from "../lib/detectAgent";
import { DOCS_URL } from "../lib/docs";
import { printJson, style } from "../lib/output";
import { HOSTED_STEPS, LOCAL_STEPS } from "../instructions/steps";
import { type Mode, readGaugeState } from "../lib/gaugeState";
import { resolve } from "node:path";
import { scaffoldWorkspace, type ScaffoldResult } from "../lib/scaffold";
export type InitDependencies = { cwd?: string };
export type InitResult = ScaffoldResult;

const LOGO = String.raw`

 ⣠⣶⣿⡿⠿⣿⣿⣦⡀                                            ⣼⣷⣄
⣰⣿⡿⠁   ⠙⠿⠿⠄ ⢀⣤⣤⣤⣤⡀ ⢠⣤⡄  ⢠⣤⡄ ⢀⣤⣤⣤⡀⣤⣤  ⣀⣤⣤⣤⣄⡀         ⢀⣼⣿⣿⣿⣀
⣿⣿⡇  ⣶⣶⣶⣶⣶⡆⠰⠿⠟⠉⠉⢿⣿⡆⢸⣿⡇  ⢸⣿⡇⢰⣿⡿⠋⠉⠻⣿⣿ ⣼⣿⠟⠉⠙⢿⣷⡄       ⢠⣾⣿⣿⣿⣿⠿⢿⣷⡄
⢿⣿⣇  ⠉⠉⠉⣿⣿⡇⢠⣶⣾⠿⠿⢿⣿⡇⢸⣿⡇  ⢸⣿⡇⢸⣿⡇   ⣿⣿ ⣿⣿⣿⣿⣿⣿⣿⡇   ⣿⣄⢀⣴⣿⣿⣿⣿⣿⣷⣶⣶⣿⣿⣶⣶⣶⡆
⠈⢿⣿⣦⣤⣀⣤⣾⢿⣿⡇⢿⣿⣇⡀⣀⣾⣿⡇⢸⣿⣷⣀⣀⣾⣿⡇⠘⣿⣿⣄⣀⣴⣿⣿ ⢻⣿⣦⣀⣀⣶⣶⠆  ⠙⠛⠋⠈⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠇
  ⠉⠛⠛⠛⠛⠁⠘⠛⠃⠈⠙⠛⠛⠋⠘⠛⠃ ⠙⠛⠛⠋⠘⠛⠃⢀⣈⣙⠛⠋⠁⣿⣿  ⠉⠛⠛⠛⠛⠁        ⠹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠋
                            ⠻⢿⣷⣶⣿⠿⠋                 ⠈⢿⠿⠋⠉
`;

const BARK = String.raw`
                                                     ⣀
 ⣠⣶⣿⡿⠿⣿⣿⣦⡀                                          ⢠⣿⣷⣄
⣰⣿⡿⠁   ⠙⠿⠿⠄ ⢀⣤⣤⣤⣤⡀ ⢠⣤⡄  ⢠⣤⡄ ⢀⣤⣤⣤⡀⣤⣤  ⣀⣤⣤⣤⣄⡀        ⢀⣾⣿⣿⣿⣤⣄⣀      ⣠⡾⠋
⣿⣿⡇  ⣶⣶⣶⣶⣶⡆⠰⠿⠟⠉⠉⢿⣿⡆⢸⣿⡇  ⢸⣿⡇⢰⣿⡿⠋⠉⠻⣿⣿ ⣼⣿⠟⠉⠙⢿⣷⡄      ⢀⣾⣿⣿⣿⣿⠛⠛⣿⣧⣀⣠⣤⣄ ⠨⠶⠶⠶
⢿⣿⣇  ⠉⠉⠉⣿⣿⡇⢠⣶⣾⠿⠿⢿⣿⡇⢸⣿⡇  ⢸⣿⡇⢸⣿⡇   ⣿⣿ ⣿⣿⣿⣿⣿⣿⣿⡇  ⢰⣄ ⣠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⠿⠿ ⠘⢷⣤⡀
⠈⢿⣿⣦⣤⣀⣤⣾⢿⣿⡇⢿⣿⣇⡀⣀⣾⣿⡇⢸⣿⣷⣀⣀⣾⣿⡇⠘⣿⣿⣄⣀⣴⣿⣿ ⢻⣿⣦⣀⣀⣶⣶⠆  ⠾⠿⠋⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡦    ⠈
  ⠉⠛⠛⠛⠛⠁⠘⠛⠃⠈⠙⠛⠛⠋⠘⠛⠃ ⠙⠛⠛⠋⠘⠛⠃⢀⣈⣙⠛⠋⠁⣿⣿  ⠉⠛⠛⠛⠛⠁       ⠈⠻⣿⣿⣿⣿⡿⠿⠛⠛⠛⠋
                            ⠻⢿⣷⣶⣿⠿⠋                 ⠈⠿⠟⠁
`;

const SMALL_LOGO = String.raw`█▀▀ ▄▀█ █ █ █▀▀ █▀▀
█▄█ █▀█ █▄█ █▄█ ██▄`;

async function printLogo(): Promise<void> {
  const out = process.stdout;
  if (detectAgent(process.env, out.isTTY) === "agent") {
    console.log(SMALL_LOGO);
    return;
  }
  if (process.env.CI || process.env.TERM === "dumb") {
    console.log(LOGO.replace(/^\n+/, ""));
    return;
  }
  out.write("\x1b[?25l");
  try {
    out.write(LOGO);
    const up = `\x1b[${LOGO.split("\n").length - 1}A`;
    for (const [frame, wait] of [
      [BARK, 220],
      [LOGO, 150],
      [BARK, 220],
      [LOGO, 150],
      [BARK, 220],
      [LOGO, 150],
    ] as const) {
      await delay(wait);
      out.write(up + frame.replace(/\n/g, "\x1b[K\n"));
    }
    out.write("\n");
  } finally {
    out.write("\x1b[?25h");
  }
}

function nextSteps(mode: Mode): string {
  const bold = style("1");
  const cyan = style("36");
  const dim = style("2");
  const lines: string[] = [];
  lines.push(`  ${bold("1. Install the Gauge agent skill")}`);
  lines.push(`     ${cyan("$ gauge install-skill")}`);
  lines.push(
    `     ${dim("·")} Recommended. It teaches your coding agent the Gauge workflows.`,
  );
  if (detectAgent(process.env, process.stdout.isTTY) === "agent")
    lines.push(
      `     ${dim("·")} Ask the user whether to install it, unless already installed or declined.`,
    );
  lines.push("");
  (mode === "hosted" ? HOSTED_STEPS : LOCAL_STEPS).forEach((step, i) => {
    lines.push(`  ${bold(`${i + 2}. ${step.title}`)}`);
    if (step.command) lines.push(`     ${cyan(`$ ${step.command}`)}`);
    for (const detail of step.details) lines.push(`     ${dim("·")} ${detail}`);
    lines.push("");
  });
  lines.push(
    `Agents: add ${cyan("-o json")} to any gauge command for JSON output.`,
  );
  lines.push(
    "Agents: the user does not see gauge output. After each step, tell them what Gauge did and found.",
  );
  lines.push(`Docs: ${cyan(DOCS_URL)}`);
  return lines.join("\n");
}

export function summarize(result: ScaffoldResult): string {
  return `${result.gaugeJson === "created" ? "Created" : "Kept"} gauge.json. Backend: ${result.backend} (.gauge/config.json). Local state: .gauge/gauge.sqlite.${result.casesDir === "not-requested" ? "" : ` Shared cases: gauge-cases/ (${result.casesDir}).`}`;
}

export function register(
  program: Command,
  { cwd = process.cwd() }: InitDependencies = {},
): void {
  program
    .command("init")
    .description(
      "Initialize a Gauge workspace: shared gauge.json and private .gauge/ state. No Git or account required. Backend defaults to local independently of login.",
    )
    .option("--cases", "also scaffold shared gauge-cases/ files")
    .action(async (opts: { cases?: boolean }, cmd: Command) => {
      const state = readGaugeState(cmd.optsWithGlobals(), cwd);
      if (state.config === null)
        throw new CliError(
          "usage",
          "gauge.json is not valid JSON. Fix it before initializing.",
        );
      const result = scaffoldWorkspace(
        state.root ?? resolve(cwd),
        state.mode,
        opts.cases,
      );
      if (resolveOutput(cmd) === "json") {
        printJson(result);
        return;
      }
      await printLogo();
      console.log(`${style("32")("✓")} gauge init complete`);
      console.log(summarize(result));
      console.log(nextSteps(state.mode));
    });
}
