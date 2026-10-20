import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentKind } from "@withgauge/local-execution";
import { CliError } from "./client";

const exec = promisify(execFile);
const tools = ["sh", "bash", "git", "sha256sum", "mkdir", "cp", "tar", "chmod", "touch", "node", "npm", "jq", "curl"];
const harnesses: Record<AgentKind, string> = {
  "claude-code": "claude", codex: "codex", pi: "pi", opencode: "opencode",
};
const marker = "GAUGE_RUNTIME_COMPATIBLE";

export async function checkLocalRuntimeCompatibility(
  imageId: string,
  agents: AgentKind[],
): Promise<void> {
  if (!process.getuid || !process.getgid)
    throw new CliError("usage", "Local runtime execution requires a Unix host UID/GID.", {
      hint: "Run Gauge on macOS or Linux with local Docker running Linux containers, or inside WSL on Windows.",
    });
  const directory = await mkdtemp(join(tmpdir(), "gauge-runtime-check-"));
  const name = `gauge-runtime-check-${randomUUID()}`;
  try {
    if (/[,"\n]/.test(directory))
      throw new CliError("usage", "The temporary directory cannot be mounted by Docker.", {
        hint: "Set TMPDIR to a path without commas, quotes or newlines, then retry.",
      });
    await mkdir(join(directory, "workspace"), { mode: 0o700 });
    const commands = [...new Set(agents.map((agent) => harnesses[agent]))];
    const script = [
      "set -eu",
      ...tools.map((tool) => `command -v ${tool} >/dev/null || { echo 'missing tool: ${tool}' >&2; exit 41; }`),
      "mkdir -p /gauge/session/home /gauge/session/workspace || { echo 'session directory is not writable' >&2; exit 42; }",
      "touch /gauge/session/workspace/probe /tmp/gauge-runtime-probe || { echo 'session directory or /tmp is not writable' >&2; exit 42; }",
      "mkdir -p /gauge/session/npm/bin",
      "printf '#!/bin/sh\\nexit 0\\n' > /gauge/session/npm/bin/gauge-runtime-path-probe",
      "chmod 755 /gauge/session/npm/bin/gauge-runtime-path-probe",
      ...["sh -c", "sh -lc", "bash -lc"].map((shell) => `${shell} gauge-runtime-path-probe >/dev/null || { echo 'environment-installed tools are missing from PATH in ${shell}; rebuild from the current Gauge runtime or preserve /gauge/session/npm/bin in the system login profile and image PATH' >&2; exit 44; }`),
      "cd /gauge/session/workspace",
      "git init --quiet && git -c user.name=gauge -c user.email=gauge@localhost commit --quiet --allow-empty -m probe",
      "tar --create --gzip --file /tmp/gauge-probe.tar.gz probe",
      "tar --extract --gzip --file /tmp/gauge-probe.tar.gz --directory /gauge/session/workspace --no-same-owner --no-same-permissions",
      "sha256sum probe | sha256sum -c --quiet -",
      ...commands.map((command) => `${command} --version >/dev/null || { echo 'missing or broken harness: ${command}' >&2; exit 43; }`),
      `echo ${marker}`,
    ].join("\n");
    let stdout: string;
    try {
      ({ stdout } = await exec("docker", [
        "run", "--rm", "--pull", "never", "--name", name,
        "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`,
        "--env", "HOME=/gauge/session/home",
        "--env", "CLAUDE_CONFIG_DIR=/gauge/session/claude",
        "--env", "CODEX_HOME=/gauge/session/codex",
        "--env", "PI_CODING_AGENT_DIR=/tmp/pi-agent",
        "--env", "XDG_DATA_HOME=/gauge/session/opencode/data",
        "--env", "XDG_STATE_HOME=/gauge/session/opencode/state",
        "--mount", `type=bind,source=${join(directory, "workspace")},target=/gauge/session`,
        imageId, "sh", "-c", script,
      ], { timeout: 60_000, maxBuffer: 1024 * 1024 }));
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
      const detail = stderr ? ` ${stderr.slice(-2000)}` : " The probe failed or timed out.";
      throw new CliError("usage", `Runtime ${imageId} failed its compatibility check.${detail}`, {
        hint: "Derive from the supported Gauge runtime; preserve required tools, harnesses and the session npm bin in ordinary/login-shell PATH, permit the host UID/GID to write /gauge/session and /tmp, and have ENTRYPOINT execute the supplied command.",
      });
    }
    if (!stdout.split(/\r?\n/).includes(marker))
      throw new CliError("usage", `Runtime ${imageId} did not execute Gauge's compatibility command.`, {
        hint: 'Remove the custom ENTRYPOINT or make it finish with exec "$@". Gauge supplies sh -c and must receive its output.',
      });
  } finally {
    await exec("docker", ["rm", "--force", name], { timeout: 10_000 }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
