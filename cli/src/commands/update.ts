import {
  type SpawnSyncOptions,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import type { Command } from "commander";
import { CliError } from "../lib/client";
import { resolveOutput } from "../lib/context";
import { printJson } from "../lib/output";

type UpdateDependencies = {
  platform?: NodeJS.Platform;
  run?: (
    command: string,
    args: string[],
    options: SpawnSyncOptions,
  ) => Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "signal">;
};

export function register(
  program: Command,
  { run = spawnSync, platform = process.platform }: UpdateDependencies = {},
): void {
  program
    .command("update")
    .description(
      "Update the globally installed Gauge CLI to the latest version",
    )
    .action((_opts: unknown, command: Command) => {
      const output = resolveOutput(command);
      console.error("Updating Gauge CLI to the latest published version...");
      const result = run(
        platform === "win32" ? "npm.cmd" : "npm",
        ["install", "--global", "@withgauge/cli@latest"],
        {
          shell: platform === "win32",
          stdio: ["inherit", output === "json" ? 2 : "inherit", "inherit"],
        },
      );
      if (result.error || result.status !== 0) {
        const reason = result.error
          ? result.error.message
          : result.signal
            ? `npm was interrupted by ${result.signal}`
            : `npm exited with code ${result.status}`;
        throw new CliError(
          "internal",
          `CLI update failed: ${reason}.\nRetry with: npm install --global @withgauge/cli@latest`,
        );
      }
      if (output === "json") {
        printJson({ updated: true, package: "@withgauge/cli", tag: "latest" });
      } else {
        console.log(
          "Updated Gauge CLI. Run `gauge --version` to see the installed version.",
        );
      }
    });
}
