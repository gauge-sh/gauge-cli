import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import type { Command } from "commander";
import { CliError } from "../lib/client";
import { resolveOutput } from "../lib/context";
import { detectAgent, detectSkillAgent } from "../lib/detectAgent";
import { printJson } from "../lib/output";

type Dependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  run?: (command: string, args: string[], options: SpawnSyncOptions) =>
    Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "signal"> &
    Partial<Pick<SpawnSyncReturns<Buffer>, "stdout" | "stderr">>;
};

type InstallerSummary = { paths: string[]; audits: Record<string, string>; details?: string };

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function summarizeInstaller(output: string): InstallerSummary {
  const lines = output.replace(ANSI, "").split("\n")
    .map((line) => line.replace(/^\s*│/, "").replace(/│\s*$/, "").trim());
  const paths = [...new Set(lines.flatMap((line) => line.match(/^→ (\S+)$/)?.[1] ?? []))];
  const audits: Record<string, string> = {};
  const row = lines.findIndex((line) => /^gauge-agents\s{2,}/.test(line));
  if (row > 0) {
    const names = lines[row - 1].split(/\s{2,}/);
    const values = lines[row].split(/\s{2,}/).slice(1);
    names.forEach((name, i) => { if (values[i]) audits[name] = values[i]; });
  }
  const details = lines.flatMap((line) => line.match(/^Details: (\S+)$/)?.[1] ?? [])[0];
  return { paths, audits, details };
}

export function register(
  program: Command,
  { run = spawnSync, platform = process.platform, env = process.env, isTTY = process.stdout.isTTY }: Dependencies = {},
): void {
  program.command("install-skill")
    .description("Install Gauge's gauge-agents skill from gauge-sh/gauge-skills on GitHub using npx. People pick agents and scope in the installer; coding agents install for themselves in this project without prompts. No Gauge account needed")
    .option("-a, --agent <name>", "target an agent (e.g. claude-code or codex); repeat for multiple agents. Coding agents default to themselves", (value: string, previous: string[]) => [...previous, value], [])
    .option("-g, --global", "install across projects instead of in this repo")
    .option("-y, --yes", "skip installer prompts (requires --agent; defaults to project scope). Always on for coding agents")
    .option("--copy", "copy skill files instead of creating symlinks")
    .action((opts: { agent: string[]; global?: boolean; yes?: boolean; copy?: boolean }, cmd: Command) => {
      const quiet = detectAgent(env, isTTY) === "agent";
      const self = quiet ? detectSkillAgent(env) : undefined;
      const agents = opts.agent.length || !self ? opts.agent : [self];
      if (quiet && !agents.length)
        throw new CliError("usage", "Cannot detect the coding agent, and the installer cannot prompt here.", {
          hint: "Pass the agent, e.g. gauge install-skill --agent claude-code",
        });
      if (opts.yes && !agents.length)
        throw new CliError("usage", "--yes requires --agent to avoid installing for unrelated agents.", {
          hint: "For Claude Code: gauge install-skill --agent claude-code --yes",
        });
      // Values reach the Windows command shell when launching the npx shim.
      if (agents.some((agent) => !/^[a-z0-9-]+$/.test(agent)))
        throw new CliError("usage", "Agent names must contain only lowercase letters, digits, and hyphens.");
      const args = ["--yes", "skills@1.5.0", "add", "gauge-sh/gauge-skills", "--skill", "gauge-agents"];
      for (const agent of agents) args.push("--agent", agent);
      if (opts.global) args.push("--global");
      if (opts.yes || quiet) args.push("--yes");
      if (opts.copy) args.push("--copy");
      const json = resolveOutput(cmd) === "json";
      console.error("Installing gauge-agents from gauge-sh/gauge-skills...");
      const result = run(platform === "win32" ? "npx.cmd" : "npx", args, {
        shell: platform === "win32",
        stdio: quiet ? ["ignore", "pipe", "pipe"] : ["inherit", json ? 2 : "inherit", "inherit"],
      });
      const output = quiet ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
      if (result.error || result.status !== 0) {
        if (output) process.stderr.write(output.replace(ANSI, ""));
        const reason = result.error?.message ?? (result.signal
          ? `installer interrupted by ${result.signal}`
          : `installer exited with code ${result.status}`);
        throw new CliError("internal", `Skill installation failed: ${reason}.`, {
          hint: "Run gauge install-skill again. Node.js and network access are required.",
        });
      }
      if (!quiet) {
        if (json) printJson({ completed: true, skill: "gauge-agents" });
        else console.log("Gauge skill installer completed.");
        return;
      }
      const summary = summarizeInstaller(output);
      if (json) {
        printJson({ completed: true, skill: "gauge-agents", agents, ...summary });
        return;
      }
      console.log(`Installed gauge-agents for ${agents.join(", ")}${summary.paths.length ? `: ${summary.paths.join(", ")}` : "."}`);
      const audits = Object.entries(summary.audits).map(([name, value]) => `${name} ${value}`);
      if (audits.length)
        console.log(`skills.sh audits: ${audits.join(", ")}.${summary.details ? ` Details: ${summary.details}` : ""}`);
    });
}
