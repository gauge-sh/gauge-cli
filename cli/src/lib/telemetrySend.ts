import { configDir } from "./config";
import type { CommandEvent } from "./telemetry";
import { installationId, telemetryStatus } from "./telemetryState";

const PROJECT_KEY = "phc_ie28UsMXVQHo6fnwNV6oOu9bdOpAebflg3vMFxr8LES";
const CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/?ip=0";
export const REQUEST_TIMEOUT_MS = 2_000;
export const WORKER_TIMEOUT_MS = 3_000;

export async function sendTelemetry(
  event: CommandEvent,
  options: { directory?: string; fetch?: typeof fetch } = {},
): Promise<void> {
  try {
    const directory = options.directory ?? configDir();
    if (!(await telemetryStatus(directory)).enabled) return;
    const id = await installationId(directory);
    if (!(await telemetryStatus(directory)).enabled) return;
    const response = await (options.fetch ?? fetch)(CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        api_key: PROJECT_KEY,
        event: "cli_command_invoked",
        distinct_id: id,
        timestamp: event.timestamp,
        properties: {
          command: event.command,
          cli_version: event.cliVersion,
          $process_person_profile: false,
          $geoip_disable: true,
          $ip: "0.0.0.0",
        },
      }),
    });
    await response.body?.cancel();
  } catch {
  }
}

export async function runTelemetryWorker(
  send: () => Promise<void>,
): Promise<never> {
  setTimeout(() => process.exit(0), WORKER_TIMEOUT_MS);
  try {
    await send();
  } catch {
  }
  process.exit(0);
}
