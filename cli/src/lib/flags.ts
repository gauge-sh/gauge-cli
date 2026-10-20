import { readFileSync } from "node:fs";
import { runConfig, type runs } from "@withgauge/api-schemas";
import { CliError } from "./client";

export function parseLimit(raw: string): number {
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new CliError("usage", "--limit must be an integer between 1 and 200");
  }
  return limit;
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function once(flag: string) {
  return (value: string, previous?: string): string => {
    if (previous !== undefined)
      throw new CliError("usage", `${flag} takes one id; start one run per id`);
    return value;
  };
}

export function tagsFrom(opts: { tag: string[]; clear?: boolean }): string[] {
  if (opts.tag.length > 0 && opts.clear)
    throw new CliError("usage", "--tag and --clear conflict");
  if (opts.tag.length === 0 && !opts.clear)
    throw new CliError("usage", "pass --tag <name> (repeatable) or --clear");
  return opts.clear ? [] : opts.tag;
}

const AGENT_ALIASES: Record<string, runs.Agent> = {
  "claude-code": "CLAUDE_CODE",
  claude_code: "CLAUDE_CODE",
  claude: "CLAUDE_CODE",
  codex: "CODEX_CLI",
  "codex-cli": "CODEX_CLI",
  codex_cli: "CODEX_CLI",
  cursor: "CURSOR",
  pi: "PI",
  opencode: "OPENCODE",
  "open-code": "OPENCODE",
  open_code: "OPENCODE",
};

export function parseAgents(raw: string): runs.Agent[] {
  const out: runs.Agent[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!name) continue;
    const agent = AGENT_ALIASES[name.toLowerCase()];
    if (!agent) {
      throw new CliError(
        "usage",
        `unknown agent "${name}" (expected: claude-code, codex, cursor, pi, opencode)`,
      );
    }
    out.push(agent);
  }
  if (out.length === 0) throw new CliError("usage", "no agents given");
  return [...new Set(out)];
}

export function parseAgentSpec(raw: string): {
  agent: runConfig.SchedulableAgent;
  models: string[];
} {
  const colon = raw.indexOf(":");
  const name = (colon < 0 ? raw : raw.slice(0, colon)).trim();
  const agent = AGENT_ALIASES[name.toLowerCase()];
  if (!agent) {
    throw new CliError(
      "usage",
      `unknown agent "${name}" in --agent "${raw}" (expected: claude-code, codex, pi, or opencode, optionally ":model1,model2")`,
    );
  }
  if (agent === "CURSOR") {
    throw new CliError(
      "usage",
      "cursor is not schedulable — presets may roster claude-code, codex, pi, and opencode",
    );
  }
  const models =
    colon < 0
      ? []
      : raw
          .slice(colon + 1)
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
  if (colon >= 0 && models.length === 0) {
    throw new CliError(
      "usage",
      `--agent "${raw}" has a ":" but no models — drop the colon for the agent default`,
    );
  }
  return { agent, models: [...new Set(models)] };
}

export function buildAgentRoster(
  specs: string[],
): { agent: runConfig.SchedulableAgent; models: string[] }[] {
  const byAgent = new Map<runConfig.SchedulableAgent, Set<string>>();
  for (const raw of specs) {
    const { agent, models } = parseAgentSpec(raw);
    const set = byAgent.get(agent) ?? new Set<string>();
    for (const m of models) set.add(m);
    byAgent.set(agent, set);
  }
  return [...byAgent.entries()].map(([agent, models]) => ({
    agent,
    models: [...models],
  }));
}

export function validateAssetRefs(
  kind: "skill" | "mcp",
  refs: string[],
): string[] {
  const parsed = runConfig.assetRefListSchema.safeParse(refs);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CliError(
      "usage",
      `invalid --${kind} reference: ${first?.message ?? "expected name@label"}`,
    );
  }
  return refs;
}

export function readPromptText(opts: { text?: string; file?: string }): string {
  if ((opts.text === undefined) === (opts.file === undefined)) {
    throw new CliError("usage", "pass exactly one of --text or --file");
  }
  if (opts.text !== undefined) return opts.text;
  const text = readFileSync(
    opts.file === "-" ? 0 : (opts.file as string),
    "utf8",
  ).trim();
  if (!text) throw new CliError("usage", "prompt file is empty");
  return text;
}
