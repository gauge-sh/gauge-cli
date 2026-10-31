import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { CliError, resolveBaseUrl } from "../lib/client";
import { resolveOutput, selectedOrg } from "../lib/context";
import { gaugeState } from "../lib/gaugeState";
import { localDirectory } from "../lib/localMeasurements";
import { findOrganization } from "../lib/orgDirectory";
import { printJson } from "../lib/output";
import { CLI_VERSION } from "../version";

type WatchState = { pid: number; port: number; url: string; version: string };

async function readWatchState(gaugeDir: string): Promise<WatchState | undefined> {
  try {
    return JSON.parse(await readFile(join(gaugeDir, "watch.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(
  state: WatchState,
): Promise<{ gauge?: string; version?: string; gaugeDir?: string } | undefined> {
  try {
    const res = await fetch(`${state.url}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return (await res.json()) as { gauge?: string; version?: string; gaugeDir?: string };
  } catch {
    return undefined;
  }
}

async function ours(state: WatchState, gaugeDir: string) {
  if (!Number.isSafeInteger(state.pid) || !alive(state.pid)) return undefined;
  const body = await health(state);
  return body?.gauge === "watch" && body.gaugeDir === gaugeDir ? body : undefined;
}

export async function stopWatchServer(gaugeDir: string): Promise<boolean> {
  const state = await readWatchState(gaugeDir);
  if (!state) return false;
  const running = Boolean(await ours(state, gaugeDir));
  if (running) {
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (alive(state.pid) && Date.now() < deadline) await delay(50);
  }
  await rm(join(gaugeDir, "watch.json"), { force: true });
  return running;
}

export async function ensureWatchServer(
  gaugeDir: string,
): Promise<WatchState & { reused: boolean }> {
  const existing = await readWatchState(gaugeDir);
  if (existing && (await ours(existing, gaugeDir))?.version === CLI_VERSION)
    return { ...existing, reused: true };
  await stopWatchServer(gaugeDir);
  const bundled = fileURLToPath(new URL("./watchServer.js", import.meta.url));
  const args = existsSync(bundled)
    ? [bundled]
    : [...process.execArgv, fileURLToPath(new URL("../watchServer.ts", import.meta.url))];
  const logPath = join(gaugeDir, "watch.log");
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [...args, gaugeDir, CLI_VERSION], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const deadline = Date.now() + 10_000;
    while (true) {
      const state = await readWatchState(gaugeDir);
      if (state && state.pid === child.pid) {
        child.unref();
        return { ...state, reused: false };
      }
      if (exited || Date.now() >= deadline) {
        child.kill();
        throw new CliError("internal", `The watch server did not start. See ${logPath}`);
      }
      await delay(50);
    }
  } finally {
    await log.close();
  }
}

async function hostedUrl(command: Command): Promise<string> {
  const selection = selectedOrg(command);
  if (!selection)
    throw new CliError(
      "usage",
      "No organization selected. Pass --org <org> or set a default with `gauge orgs use <org>`.",
      { needsAccount: true },
    );
  const { slug } = await findOrganization(selection.value);
  const base = resolveBaseUrl().replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(slug)}/chat/dashboard?liveruns=true`;
}

export function register(program: Command): void {
  const watch = program
    .command("watch")
    .description(
      "Print a URL for a live, read-only view of past and running sessions (local: starts a background server)",
    )
    .action(async (_opts: unknown, command: Command) => {
      const json = resolveOutput(command) === "json";
      if (gaugeState(command).mode === "hosted") {
        const url = await hostedUrl(command);
        if (json) printJson({ mode: "hosted", url });
        else console.log(url);
        return;
      }
      const state = await ensureWatchServer(localDirectory(command));
      if (json) printJson({ mode: "local", ...state });
      else {
        console.log(state.url);
        console.error("Stop: gauge watch stop");
      }
    });

  watch
    .command("stop")
    .description("Stop this workspace's background watch server")
    .action(async (_opts: unknown, command: Command) => {
      const stopped = await stopWatchServer(localDirectory(command));
      if (resolveOutput(command) === "json") printJson({ stopped });
      else console.log(stopped ? "Watch server stopped." : "No watch server is running.");
    });
}
