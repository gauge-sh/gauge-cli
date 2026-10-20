import { join } from "node:path";
import type { Command } from "commander";
import { CliError } from "../lib/client";
import { gaugeState } from "../lib/gaugeState";
import { cleanupLocal } from "../lib/localLifecycle";
import { resolveOutput } from "../lib/context";
import { printJson } from "../lib/output";

export function register(program: Command): void {
  program
    .command("cleanup")
    .description(
      "Clean interrupted Gauge sessions in this repository (local only); preserve results and images",
    )
    .action(async (_opts: unknown, command: Command) => {
      const state = gaugeState(command);
      if (state.mode !== "local" || !state.root)
        throw new CliError(
          "usage",
          "Use --local inside the batch's Git repository",
        );
      const results = await cleanupLocal(join(state.root, ".gauge"));
      if (results.some((r) => r.status === "error")) process.exitCode = 1;
      if (resolveOutput(command) === "json") printJson({ sessions: results });
      else {
        if (!results.length)
          console.log("No interrupted sessions need cleanup.");
        for (const result of results)
          console.log(
            `${result.id}: ${result.status}${result.detail ? ` (${result.detail})` : ""}`,
          );
      }
    });
}
