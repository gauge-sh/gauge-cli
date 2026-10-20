export type Caller = "agent" | "human";

const SKILL_AGENTS: Record<string, string> = {
  CLAUDECODE: "claude-code",
  CODEX_SANDBOX: "codex",
  CODEX_THREAD_ID: "codex",
  CODEX_CI: "codex",
  CURSOR_AGENT: "cursor",
  GEMINI_CLI: "gemini-cli",
  CLINE_ACTIVE: "cline",
  OPENCODE: "opencode",
};

const AGENT_MARKERS = [...Object.keys(SKILL_AGENTS), "AI_AGENT"];

export function detectAgent(
  env: NodeJS.ProcessEnv,
  stdoutIsTTY: boolean | undefined,
): Caller {
  if (AGENT_MARKERS.some((name) => env[name])) return "agent";
  return stdoutIsTTY ? "human" : "agent";
}

export function detectSkillAgent(env: NodeJS.ProcessEnv): string | undefined {
  return Object.entries(SKILL_AGENTS).find(([name]) => env[name])?.[1];
}
