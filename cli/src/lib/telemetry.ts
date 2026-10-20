import childProcess from "node:child_process";
import type { Command } from "commander";
import { CLI_VERSION } from "../version";

export type CommandEvent = {
  command: string;
  timestamp: string;
  cliVersion: string;
};

export function registerTelemetry(program: Command, workerPath: string): void {
  program.hook("preAction", (_program, command) => {
    try {
      if (process.env.GAUGE_TELEMETRY_DISABLED === "1") return;
      const names: string[] = [];
      for (
        let current: Command | null = command;
        current?.parent;
        current = current.parent
      )
        names.unshift(current.name());
      if (!names.length || names[0] === "telemetry") return;
      const event: CommandEvent = {
        command: names.join(" "),
        timestamp: new Date().toISOString(),
        cliVersion: CLI_VERSION,
      };
      const child = childProcess.spawn(
        process.execPath,
        [workerPath, JSON.stringify(event)],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      child.on("error", () => {});
      child.unref();
    } catch {
    }
  });
}
