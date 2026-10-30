import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { CliError } from "./client";
import { readConfig } from "./config";
import { resolveToken } from "./credentials";

export type Mode = "local" | "hosted";
export type ModeSource = "flag" | "workspace" | "user" | "default";
export type GaugeState = {
  mode: Mode;
  source: ModeSource;
  inRepo: boolean;
  root?: string;
  config?: Record<string, unknown> | null;
  signedIn: boolean;
  orgId?: string;
};
export type Account = Pick<GaugeState, "signedIn" | "orgId"> & {
  backend?: Mode;
};

export function findWorkspace(cwd = process.cwd()): string | undefined {
  let directory = resolve(cwd);
  while (true) {
    if (
      existsSync(join(directory, "gauge.json")) ||
      existsSync(join(directory, ".gauge", "config.json"))
    )
      return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function gaugeState(command: Command, cwd = process.cwd()): GaugeState {
  return readGaugeState(command.optsWithGlobals(), cwd);
}
export function resolveMode(command: Command, cwd = process.cwd()): Mode {
  return gaugeState(command, cwd).mode;
}
function backend(value: unknown, location: string): Mode | undefined {
  if (value === undefined) return undefined;
  if (value === "local" || value === "hosted") return value;
  throw new CliError(
    "usage",
    `Invalid backend in ${location}: expected local or hosted`,
  );
}
export function readGaugeState(
  flags: { local?: boolean; hosted?: boolean },
  cwd = process.cwd(),
  account: Account = { signedIn: resolveToken() !== null, ...readConfig() },
): GaugeState {
  const root = findWorkspace(cwd);
  let config: Record<string, unknown> | null | undefined;
  let workspaceBackend: Mode | undefined;
  if (root) {
    if (!existsSync(join(root, "gauge.json"))) config = {};
    else
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(join(root, "gauge.json"), "utf8"),
        );
        config =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
      } catch {
        config = null;
      }
    if (config && "mode" in config)
      throw new CliError(
        "usage",
        "gauge.json does not accept mode. Set backend in private .gauge/config.json; keep the project manifest backend-independent.",
      );
    const path = join(root, ".gauge", "config.json");
    if (existsSync(path)) {
      let value: { version?: unknown; backend?: unknown };
      try {
        value = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        throw new CliError("usage", `${path} is not valid JSON`);
      }
      if (!value || value.version !== 1)
        throw new CliError(
          "usage",
          `Unsupported workspace configuration version in ${path}`,
        );
      workspaceBackend = backend(value.backend, path);
    }
  }
  const userBackend = backend(account.backend, "user configuration");
  const [mode, source]: [Mode, ModeSource] = flags.local
    ? ["local", "flag"]
    : flags.hosted
      ? ["hosted", "flag"]
      : workspaceBackend
        ? [workspaceBackend, "workspace"]
        : userBackend
          ? [userBackend, "user"]
          : ["local", "default"];
  return {
    mode,
    source,
    root,
    inRepo: root !== undefined,
    config,
    signedIn: account.signedIn,
    orgId: account.orgId,
  };
}
export function instructionMode(state: GaugeState): {
  mode: Mode;
  why: string;
} {
  const why = {
    flag: "from the flag",
    workspace: "from .gauge/config.json",
    user: "from user configuration",
    default: "the default",
  };
  return { mode: state.mode, why: why[state.source] };
}
export function header(
  state: GaugeState,
  topic?: { key: string; local: boolean; shared?: boolean },
  brief = false,
): string[] {
  const { mode, why } = instructionMode(state);
  const lines = [
    `Mode: ${mode} (${why}). Pass --${mode === "local" ? "hosted" : "local"} to switch for this command.`,
  ];
  if (mode === "local" && topic && !topic.local && !topic.shared)
    lines.push(
      "This topic is hosted only. Local guidance: `gauge instructions --local`.",
    );
  if (state.config === null)
    lines.push(
      "gauge.json is not valid JSON. Fix it before using this workspace.",
    );
  else if (!state.root && !brief)
    lines.push(
      "Run `gauge init` to initialize this directory. It writes only private .gauge/ state. Add --cases to also write shared gauge.json, gauge-cases/, and an AGENTS.md block.",
    );
  else if (!brief && (!topic || topic.key === "root"))
    lines.push(
      "Next: `gauge instructions eval` or `gauge instructions preference` to create a saved measurement; `gauge instructions run` to launch it.",
    );
  return lines;
}
