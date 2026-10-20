import type { SessionSpec, AgentKind } from "./types.js";
export const SESSION_DIR = "/gauge/session";
export const WORKSPACE_DIR = `${SESSION_DIR}/workspace`;
export const BASE_COMMIT_MARKER = "GAUGE_BASE_COMMIT";
export const PI_AGENT_DIR = "/tmp/pi-agent";
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function splitModel(model: string): { provider: string; model: string } {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) throw new Error(`model must be provider/model, got ${model}`);
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}
export function agentEnv(agent: AgentKind): Record<string, string> {
  switch (agent) {
    case "claude-code": return { CLAUDE_CONFIG_DIR: `${SESSION_DIR}/claude` };
    case "codex": return { CODEX_HOME: `${SESSION_DIR}/codex` };
    case "pi": return { PI_CODING_AGENT_DIR: PI_AGENT_DIR };
    case "opencode": return {
      XDG_DATA_HOME: `${SESSION_DIR}/opencode/data`,
      XDG_STATE_HOME: `${SESSION_DIR}/opencode/state`,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, permission: { "*": "allow", question: "ask" } }),
    };
  }
}
export function prepareScript(spec: SessionSpec): string {
  const lines = ["set -eu"];
  for (const resource of spec.resources) {
    const src = `/gauge/inputs/${resource.name}`;
    const dest = `${SESSION_DIR}/resources/${resource.name}`;
    const hex = resource.digest.replace(/^sha256:/, "");
    lines.push(
      `echo ${shellQuote(`${hex}  ${src}`)} | sha256sum -c --quiet -`,
      `mkdir -p ${shellQuote(dest)}`,
      `cp ${shellQuote(src)} ${shellQuote(`${dest}/${resource.filename}`)}`,
    );
  }
  lines.push(`mkdir -p ${SESSION_DIR}/home ${SESSION_DIR}/claude ${SESSION_DIR}/codex ${SESSION_DIR}/opencode ${SESSION_DIR}/pi`);
  if (spec.workspace) lines.push(
    `git clone --quiet -- ${shellQuote(spec.workspace.repo)} ${WORKSPACE_DIR}`,
    `cd ${WORKSPACE_DIR}`,
    `ref=${shellQuote(spec.workspace.ref)}`,
    `git rev-parse --verify --quiet "$ref^{commit}" >/dev/null || ref="origin/$ref"`,
    `git checkout --quiet --detach "$ref"`,
  );
  else lines.push(
    `git init --quiet ${WORKSPACE_DIR}`,
    `cd ${WORKSPACE_DIR}`,
    "git -c user.name=gauge -c user.email=gauge@localhost commit --quiet --allow-empty -m base",
  );
  lines.push("gauge_base_commit=$(git rev-parse HEAD)");
  const skillRoot: Record<AgentKind, string> = {
    "claude-code": `${SESSION_DIR}/claude/skills`, codex: `${SESSION_DIR}/codex/skills`,
    pi: `${PI_AGENT_DIR}/skills`, opencode: `${SESSION_DIR}/home/.config/opencode/skills`,
  };
  for (const resource of spec.resources) {
    if (resource.kind !== "archive") continue;
    const root = `${SESSION_DIR}/resources/${resource.name}`;
    const contents = `${root}/content`;
    lines.push(`mkdir -p ${shellQuote(contents)}`,
      `tar --extract --gzip --file ${shellQuote(`${root}/${resource.filename}`)} --directory ${shellQuote(contents)} --no-same-owner --no-same-permissions`);
    if (resource.use?.type === "skill") {
      const target = `${skillRoot[spec.agent.kind]}/${resource.name}`;
      lines.push(`test -f ${shellQuote(`${contents}/SKILL.md`)}`, `mkdir -p ${shellQuote(target)}`, `cp -R ${shellQuote(`${contents}/.`)} ${shellQuote(target)}`);
    } else if (resource.use?.type === "npm-package") {
      const args = resource.use.install === "environment" ? `--global --prefix ${SESSION_DIR}/npm` : "";
      lines.push(`npm install --no-audit --no-fund ${args} ${shellQuote(`${contents}/${resource.use.package}`)} >&2`);
      if (resource.use.install === "environment") lines.push(
        `case ":$PATH:" in *:${SESSION_DIR}/npm/bin:*) ;; *) export PATH=${SESSION_DIR}/npm/bin:$PATH ;; esac`,
      );
    }
  }
  lines.push(`echo "${BASE_COMMIT_MARKER} $gauge_base_commit"`);
  return lines.join("\n");
}

export function captureScript(baseCommit: string): string {
  return [
    "set -eu",
    `cd ${WORKSPACE_DIR}`,
    "git add --all --intent-to-add .",
    `git diff --binary ${shellQuote(baseCommit)}`,
  ].join("\n");
}

export function harnessCommand(spec: SessionSpec): string[] {
  switch (spec.agent.kind) {
    case "claude-code": return ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", spec.agent.model, "--dangerously-skip-permissions", "--permission-prompt-tool", "stdio"];
    case "codex": return ["codex", "app-server", "--listen", "stdio://"];
    case "pi": {
      const m = splitModel(spec.agent.model);
      return ["pi", "--mode", "rpc", "--no-approve", "--session-dir", "/gauge/session/pi", "--provider", m.provider, "--model", m.model];
    }
    case "opencode": return ["opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096"];
  }
}
