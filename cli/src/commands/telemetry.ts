import type { Command } from "commander";
import { printJson } from "../lib/output";
import { setTelemetryEnabled, telemetryStatus } from "../lib/telemetryState";

async function printStatus(command: Command): Promise<void> {
  const status = await telemetryStatus();
  if (command.optsWithGlobals().output === "json") {
    printJson(status);
    return;
  }
  console.log(
    `CLI telemetry is ${status.enabled ? "enabled" : "disabled"} (${status.source}).`,
  );
  if (status.source === "environment")
    console.log("GAUGE_TELEMETRY_DISABLED=1 overrides the saved preference.");
  if (status.source === "unavailable")
    console.log(
      "Preferences could not be read. Collection is disabled until repaired with gauge telemetry enable or disable.",
    );
}

export function register(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("Control anonymous CLI usage telemetry (enabled by default)");
  telemetry
    .command("status")
    .description("Show whether CLI telemetry is enabled")
    .action(async (_options, command: Command) => printStatus(command));
  for (const enabled of [true, false]) {
    telemetry
      .command(enabled ? "enable" : "disable")
      .description(
        `${enabled ? "Enable" : "Disable"} CLI telemetry for this user`,
      )
      .action(async (_options, command: Command) => {
        await setTelemetryEnabled(enabled);
        await printStatus(command);
      });
  }
}
